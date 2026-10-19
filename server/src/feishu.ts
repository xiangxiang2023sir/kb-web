import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'
import { newId, type KbDb } from './db.js'
import { runAsk, type AskEmit } from './ask.js'
import type { AppConfig, User } from './config.js'

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

export function collectAnswer(): { emit: AskEmit; text: () => string; error: () => string; sessionId: () => string | undefined } {
  let text = ''
  let error = ''
  let sessionId: string | undefined
  const citations: string[] = []
  return {
    emit(event) {
      if (event.type === 'delta') text += String(event.text ?? '')
      if (event.type === 'error') error = String(event.message ?? '')
      if (event.type === 'session') sessionId = String(event.sessionId ?? '')
      if (event.type === 'citation') {
        const c = event.citation as { marker?: string; title?: string } | undefined
        if (c?.title) citations.push(`${c.marker ?? ''} ${c.title}`.trim())
      }
    },
    text: () => (citations.length ? `${text}\n\n出处：\n${citations.join('\n')}` : text),
    error: () => error,
    sessionId: () => sessionId,
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

export function issueBindCode(db: KbDb, userId: string): { code: string; expiresIn: number } {
  const code = randomBytes(3).toString('hex').toUpperCase()
  db.createFeishuBindCode(code, userId, 5 * 60)
  return { code, expiresIn: 300 }
}

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

  const bind = /^绑定\s*([A-Za-z0-9]{6})$/.exec(text)
  if (bind) {
    const userId = db.consumeFeishuBindCode(bind[1].toUpperCase())
    if (!userId) {
      await send(message.chat_id, message.message_id, '验证码无效或已过期。请在知识库网页重新生成。')
      return
    }
    db.bindFeishu(openId, userId)
    const user = db.findUserById(userId)
    await send(message.chat_id, message.message_id, `已绑定为 ${user?.name ?? userId}。以后在这里提问会按你的权限检索。`)
    return
  }
  if (text === '解绑') {
    db.unbindFeishu(openId)
    await send(message.chat_id, message.message_id, '已解绑。再问需要重新绑定。')
    return
  }
  if (text === '帮助' || text === 'help') {
    await send(
      message.chat_id,
      message.message_id,
      '我是工厂知识库助手。\n1. 在网页登录，点「绑定飞书」拿到验证码\n2. 发给我：绑定 ABC123\n3. 之后直接问设备、规程、故障\n4. 想记录经验/日报：发「记一下：<内容>」或「日报：<内容>」\n发送「解绑」取消。',
    )
    return
  }

  const binding = db.getFeishuBinding(openId)
  if (!binding) {
    await send(
      message.chat_id,
      message.message_id,
      '还没绑定账号。请先在知识库网页登录，点「绑定飞书」，然后把验证码发我：绑定 ABC123',
    )
    return
  }
  const user = db.findUserById(binding.userId)
  if (!user) {
    db.unbindFeishu(openId)
    await send(message.chat_id, message.message_id, '绑定的账号已不存在，请重新绑定。')
    return
  }

  // ---- 飞书里直接提交经验/日报：进「待确认」，管理员确认后才进正式库 ----
  const intake = /^(记一下|记录一下|记录|记一条|提交经验|经验\s*[:：]|日报\s*[:：])\s*([\s\S]+)$/.exec(text)
  if (intake) {
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

  const collected = collectAnswer()
  await runAsk(
    user,
    db,
    config,
    { type: 'ask', questionId: newId('q'), question: text, sessionId: binding.sessionId },
    collected.emit,
  )
  const sid = collected.sessionId()
  if (sid) db.setFeishuSession(openId, sid)
  const err = collected.error()
  await send(message.chat_id, message.message_id, err || collected.text() || '没有得到回答')
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
