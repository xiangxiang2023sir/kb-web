import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'
import { newId, type KbDb } from './db.js'
import type { AppConfig } from './config.js'

export function feishuConfigured(): boolean {
  return Boolean(process.env.FEISHU_APP_ID && process.env.FEISHU_APP_SECRET && process.env.FEISHU_VERIFICATION_TOKEN)
}

export interface FeishuSend {
  (chatId: string, messageId: string, text: string): Promise<void>
}

interface FeishuMessageEvent {
  sender?: { sender_id?: { open_id?: string }; sender_type?: string }
  message?: {
    message_id?: string
    chat_id?: string
    chat_type?: string
    message_type?: string
    content?: string
    mentions?: { id?: { open_id?: string } }[]
  }
}

let tokenCache: { token: string; expireAt: number } | null = null
let botOpenId = ''

export function decryptFeishu(encrypt: string, encryptKey: string): string {
  const key = createHash('sha256').update(encryptKey).digest()
  const buf = Buffer.from(encrypt, 'base64')
  const iv = buf.subarray(0, 16)
  const data = buf.subarray(16)
  const decipher = createDecipheriv('aes-256-cbc', key, iv)
  return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8')
}

export function feishuSignature(timestamp: string, nonce: string, encryptKey: string, body: string): string {
  return createHash('sha256').update(timestamp + nonce + encryptKey + body).digest('hex')
}

export function parseFeishuBody(raw: string, encryptKey: string): Record<string, unknown> {
  const outer = JSON.parse(raw) as { encrypt?: string }
  if (outer.encrypt && encryptKey) return JSON.parse(decryptFeishu(outer.encrypt, encryptKey)) as Record<string, unknown>
  return outer
}

function stripMentions(text: string): string {
  return text.replace(/@_user_\d+/g, '').replace(/\s+/g, ' ').trim()
}

function textOf(content: string): string {
  try {
    const json = JSON.parse(content) as { text?: string }
    return stripMentions(String(json.text ?? ''))
  } catch {
    return stripMentions(content)
  }
}

export async function tenantToken(): Promise<string> {
  if (tokenCache && Date.now() < tokenCache.expireAt) return tokenCache.token
  const res = await fetch('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ app_id: process.env.FEISHU_APP_ID, app_secret: process.env.FEISHU_APP_SECRET }),
  })
  const json = (await res.json()) as { tenant_access_token?: string; expire?: number; msg?: string }
  if (!json.tenant_access_token) throw new Error(json.msg || '飞书 token 失败')
  tokenCache = { token: json.tenant_access_token, expireAt: Date.now() + Math.max(60, (json.expire ?? 7200) - 120) * 1000 }
  return tokenCache.token
}

export async function replyFeishu(chatId: string, messageId: string, text: string) {
  const token = await tenantToken()
  const body = { msg_type: 'text', content: JSON.stringify({ text: text.slice(0, 4000) }) }
  const url = messageId
    ? `https://open.feishu.cn/open-apis/im/v1/messages/${encodeURIComponent(messageId)}/reply`
    : `https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=chat_id`
  const payload = messageId ? body : { receive_id: chatId, ...body }
  const res = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })
  if (!res.ok) {
    const detail = await res.text().catch(() => '')
    throw new Error(`飞书发信失败 ${res.status} ${detail.slice(0, 200)}`)
  }
}

async function botId(): Promise<string> {
  if (botOpenId) return botOpenId
  const token = await tenantToken()
  const res = await fetch('https://open.feishu.cn/open-apis/bot/v3/info', {
    headers: { Authorization: `Bearer ${token}` },
  })
  const json = (await res.json()) as { bot?: { open_id?: string } }
  botOpenId = json.bot?.open_id ?? ''
  return botOpenId
}

const POINT_TO_AGENT =
  '提问请用飞书智能体（不是这个应用号）。\n网页登录 →「绑定外部 agent」生成绑定码，智能体调 /api/agent/bind 绑好后即可按你的权限检索。\n记录经验发：记一下：<内容>'

export async function handleFeishuEvent(
  db: KbDb,
  config: AppConfig,
  event: FeishuMessageEvent,
  send: FeishuSend,
) {
  const openId = event.sender?.sender_id?.open_id
  const message = event.message
  if (!openId || !message?.message_id || !message.chat_id) return
  if (event.sender?.sender_type && event.sender.sender_type !== 'user') return

  const chatType = message.chat_type ?? 'p2p'
  if (chatType === 'group' && config.feishu.groupOnlyMention) {
    const mentions = message.mentions ?? []
    if (mentions.length === 0) return
    const me = await botId().catch(() => '')
    if (me && !mentions.some((m) => m.id?.open_id === me)) return
  }

  if (message.message_type && message.message_type !== 'text') {
    await send(message.chat_id, message.message_id, '请发送文字问题。照片请到知识库网页上传。')
    return
  }

  const text = textOf(message.content ?? '')
  if (!text) return

  if (text === '帮助' || text === 'help' || /^绑定\s*[A-Za-z0-9]{6}$/.test(text) || text === '解绑') {
    await send(message.chat_id, message.message_id, POINT_TO_AGENT)
    return
  }

  const intake = /^(记一下|记录一下|记录|记一条|提交经验|经验\s*[:：]|日报\s*[:：])\s*([\s\S]+)$/.exec(text)
  if (intake) {
    const user = db.userOfIdentity('feishu', openId)
    if (!user) {
      await send(message.chat_id, message.message_id, POINT_TO_AGENT)
      return
    }
    const trigger = intake[1]
    const body = intake[2].trim()
    if (body.length < 6) {
      await send(message.chat_id, message.message_id, '内容太短了，把要记的经验/日报写全一点。')
      return
    }
    const kind = trigger.includes('日报') ? '日报' : '经验'
    const field = user.field ?? config.defaults.field
    const title = body.split('\n')[0].replace(/^#+\s*/, '').slice(0, 40)
    db.insertDoc({
      id: newId('d'),
      title: `[${kind}] ${title}`,
      field,
      sensitivity: 'internal',
      status: 'pending',
      suggestedField: field,
      suggestedSensitivity: 'internal',
      content: `${body}\n\n---\n\n- 来源：飞书（${user.name}）\n- 时间：${new Date().toISOString()}`,
      updatedAt: new Date().toISOString(),
    })
    await send(
      message.chat_id,
      message.message_id,
      `已收到（${kind}）：${title}\n已进「待确认」，管理员确认后才进正式知识库。`,
    )
    return
  }

  await send(message.chat_id, message.message_id, POINT_TO_AGENT)
}

/** 给测试用：不发包，只走验签与解析。 */
export function verifyFeishuRequest(headers: Record<string, string | undefined>, raw: string): { ok: true } | { ok: false; status: number; message: string } {
  const token = process.env.FEISHU_VERIFICATION_TOKEN ?? ''
  const encryptKey = process.env.FEISHU_ENCRYPT_KEY ?? ''
  const timestamp = headers['x-lark-request-timestamp'] ?? headers['x-lark-signature-timestamp'] ?? ''
  const nonce = headers['x-lark-request-nonce'] ?? headers['x-lark-signature-nonce'] ?? ''
  const sign = headers['x-lark-signature'] ?? ''
  if (encryptKey) {
    if (!timestamp || !nonce || !sign) return { ok: false, status: 401, message: '缺少签名' }
    const expect = feishuSignature(timestamp, nonce, encryptKey, raw)
    if (expect !== sign) return { ok: false, status: 401, message: '签名不对' }
  }
  let parsed: Record<string, unknown>
  try {
    parsed = parseFeishuBody(raw, encryptKey)
  } catch {
    return { ok: false, status: 400, message: '无法解析' }
  }
  const bodyToken = String(parsed.token ?? (parsed.header as { token?: string } | undefined)?.token ?? '')
  if (!encryptKey && token && bodyToken !== token) return { ok: false, status: 401, message: 'token 不对' }
  if (encryptKey && bodyToken && bodyToken !== token) return { ok: false, status: 401, message: 'token 不对' }
  return { ok: true }
}

export function challengeOf(parsed: Record<string, unknown>): string | null {
  if (parsed.type === 'url_verification' && parsed.challenge) return String(parsed.challenge)
  if (parsed.challenge && !parsed.header) return String(parsed.challenge)
  return null
}

export function eventPayload(parsed: Record<string, unknown>): { eventId: string; event: FeishuMessageEvent } | null {
  const header = parsed.header as { event_id?: string; event_type?: string } | undefined
  if (header?.event_type && header.event_type !== 'im.message.receive_v1') return null
  const event = (parsed.event ?? parsed) as FeishuMessageEvent
  if (!event.message && !event.sender) return null
  return { eventId: header?.event_id ?? newId('ev'), event }
}

/** 仅测试加密往返 */
export function encryptFeishuForTest(plain: string, encryptKey: string): string {
  const key = createHash('sha256').update(encryptKey).digest()
  const iv = randomBytes(16)
  const cipher = createCipheriv('aes-256-cbc', key, iv)
  const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()])
  return Buffer.concat([iv, enc]).toString('base64')
}
