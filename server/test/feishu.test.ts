import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import assert from 'node:assert/strict'
import { openDb } from '../src/db.js'
import type { AppConfig } from '../src/config.js'
import {
  challengeOf,
  encryptFeishuForTest,
  eventPayload,
  feishuSignature,
  handleFeishuEvent,
  parseFeishuBody,
  verifyFeishuRequest,
} from '../src/feishu.js'
import { start } from '../src/app.js'

const fakeGbrain = fileURLToPath(new URL('./fake-gbrain.mjs', import.meta.url))

function stubConfig(over: Partial<AppConfig['feishu']> = {}): AppConfig {
  return {
    auth: { cookieName: 'kb_sid', ttlDays: 1 },
    search: { fetchLimit: 10, keep: 5, maxPages: 1, questionPhrases: [], rerankCandidates: 0, coverageWeight: 0.6, pageChars: 4000 },
    confidence: { highMin: 0.03, mediumMin: 0.015 },
    noEvidence: { text: '没有资料', score: 0.2 },
    chat: {
      phrases: ['你好'],
      fallback: '你好',
      ackText: '知道了',
      questionWords: ['怎么', '如何', '吗'],
      historyTurns: 8,
      maxSessions: 50,
      maxTurnsPerSession: 100,
      agentIdleHours: 8,
      archiveMinMessages: 4,
    },
    keywords: { electrical: [], mechanical: [], dispatch: [] },
    sensitivityKeywords: { top_secret: [], confidential: [], public: [] },
    defaults: { field: 'electrical', sensitivity: 'internal' },
    llm: { baseUrl: 'http://127.0.0.1:9', model: 't', temperature: 0, maxTokens: 20 },
    vision: { baseUrl: '', model: '', maxImages: 4 },
    gbrain: { command: 'node', argsPrefix: [fakeGbrain], timeoutMs: 3000 },
    health: { reportIslandedPages: false },
    limits: { imageBytes: 1000, docBytes: 1000, classifyChars: 100 },
    prompts: { qa: '', classify: '', vision: '', chat: '' },
    feishu: { groupOnlyMention: over.groupOnlyMention !== false },
  }
}

function textEvent(openId: string, text: string, extra?: { chatType?: string; mentions?: string[]; messageType?: string }) {
  return {
    sender: { sender_id: { open_id: openId }, sender_type: 'user' as const },
    message: {
      message_id: 'om_1',
      chat_id: 'oc_1',
      chat_type: extra?.chatType ?? 'p2p',
      message_type: extra?.messageType ?? 'text',
      content: JSON.stringify({ text }),
      mentions: extra?.mentions?.map((id) => ({ id: { open_id: id } })),
    },
  }
}

test('飞书加解密与验签', () => {
  const key = 'encrypt-secret'
  const plain = JSON.stringify({ type: 'url_verification', challenge: 'c1', token: 'tok' })
  const enc = encryptFeishuForTest(plain, key)
  const parsed = parseFeishuBody(JSON.stringify({ encrypt: enc }), key)
  assert.equal(parsed.challenge, 'c1')
  assert.equal(challengeOf(parsed), 'c1')

  const raw = JSON.stringify({ encrypt: enc })
  const ts = '1'
  const nonce = 'n'
  process.env.FEISHU_VERIFICATION_TOKEN = 'tok'
  process.env.FEISHU_ENCRYPT_KEY = key
  const ok = verifyFeishuRequest(
    { 'x-lark-request-timestamp': ts, 'x-lark-request-nonce': nonce, 'x-lark-signature': feishuSignature(ts, nonce, key, raw) },
    raw,
  )
  assert.equal(ok.ok, true)
  const bad = verifyFeishuRequest(
    { 'x-lark-request-timestamp': ts, 'x-lark-request-nonce': nonce, 'x-lark-signature': '00' },
    raw,
  )
  assert.equal(bad.ok, false)
})

test('飞书应用号不再本体问答，经验走外部身份', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'kb-fs-'))
  const db = openDb(join(dir, 'kb.sqlite'))
  const config = stubConfig()
  try {
    const sent: string[] = []
    const send = async (_c: string, _m: string, text: string) => {
      sent.push(text)
    }

    await handleFeishuEvent(db, config, textEvent('ou_1', '绑定 ABC123'), send)
    assert.match(sent[0] ?? '', /飞书智能体/)

    sent.length = 0
    await handleFeishuEvent(db, config, textEvent('ou_2', '液压油怎么换'), send)
    assert.match(sent[0] ?? '', /绑定外部 agent/)

    sent.length = 0
    await handleFeishuEvent(db, config, textEvent('ou_1', '帮助'), send)
    assert.match(sent[0] ?? '', /下载 Skill/)

    sent.length = 0
    await handleFeishuEvent(db, config, textEvent('ou_1', '照片', { messageType: 'image' }), send)
    assert.match(sent[0] ?? '', /请发送文字/)

    sent.length = 0
    await handleFeishuEvent(db, config, textEvent('ou_1', '群里闲聊', { chatType: 'group' }), send)
    assert.equal(sent.length, 0)

    sent.length = 0
    await handleFeishuEvent(db, stubConfig({ groupOnlyMention: false }), textEvent('ou_1', '解绑', { chatType: 'group' }), send)
    assert.match(sent[0] ?? '', /飞书智能体/)

    sent.length = 0
    await handleFeishuEvent(db, config, textEvent('ou_1', '记一下：行走速度改成 0.5'), send)
    assert.match(sent[0] ?? '', /绑定外部 agent/)

    db.bindIdentity('feishu', 'ou_1', 'u3')
    sent.length = 0
    await handleFeishuEvent(db, config, textEvent('ou_1', '记一下：行走速度改成 0.5 米每秒'), send)
    assert.match(sent[0] ?? '', /已收到（经验）/)

    const payload = eventPayload({
      header: { event_id: 'ev1', event_type: 'im.message.receive_v1', token: 'tok' },
      event: textEvent('ou_1', 'hi'),
    })
    assert.equal(payload?.eventId, 'ev1')
    assert.equal(db.seenFeishuEvent('ev1'), false)
    assert.equal(db.seenFeishuEvent('ev1'), true)
  } finally {
    db.db.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('飞书 webhook 挑战、绑定码、未配置', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'kb-fs-http-'))
  writeFileSync(
    join(dir, 'config.yaml'),
    `search: { fetchLimit: 10, keep: 5, maxPages: 1 }
confidence: { highMin: 0.03, mediumMin: 0.015 }
noEvidence: { text: "没有资料", score: 0.2 }
keywords: { electrical: [], mechanical: [], dispatch: [] }
sensitivityKeywords: { top_secret: [], confidential: [], public: [] }
defaults: { field: electrical, sensitivity: internal }
llm: { baseUrl: "http://127.0.0.1:9", model: test, temperature: 0, maxTokens: 20 }
vision: { baseUrl: "", model: "", maxImages: 4 }
gbrain: { command: node, argsPrefix: [${JSON.stringify(fakeGbrain)}], timeoutMs: 5000 }
health: { reportIslandedPages: false }
limits: { imageBytes: 1000000, docBytes: 1000000, classifyChars: 1000 }
auth: { cookieName: kb_sid, ttlDays: 1 }
`,
  )
  const prev = {
    KB_CONFIG: process.env.KB_CONFIG,
    DEEPSEEK_API_KEY: process.env.DEEPSEEK_API_KEY,
    GBRAIN_BIN: process.env.GBRAIN_BIN,
    FEISHU_APP_ID: process.env.FEISHU_APP_ID,
    FEISHU_APP_SECRET: process.env.FEISHU_APP_SECRET,
    FEISHU_VERIFICATION_TOKEN: process.env.FEISHU_VERIFICATION_TOKEN,
    FEISHU_ENCRYPT_KEY: process.env.FEISHU_ENCRYPT_KEY,
  }
  process.env.KB_CONFIG = join(dir, 'config.yaml')
  process.env.DEEPSEEK_API_KEY = ''
  process.env.GBRAIN_BIN = 'node'
  process.env.FEISHU_APP_ID = ''
  process.env.FEISHU_APP_SECRET = ''
  process.env.FEISHU_VERIFICATION_TOKEN = ''
  process.env.FEISHU_ENCRYPT_KEY = ''
  const server = await start({ dataDir: dir, port: 0, host: '127.0.0.1' })
  const base = `http://127.0.0.1:${server.port}`
  try {
    const off = await fetch(`${base}/api/feishu/events`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'url_verification', challenge: 'x', token: 'tok' }),
    })
    assert.equal(off.status, 503)

    process.env.FEISHU_APP_ID = 'cli_test'
    process.env.FEISHU_APP_SECRET = 'secret'
    process.env.FEISHU_VERIFICATION_TOKEN = 'tok'

    const challenge = await fetch(`${base}/api/feishu/events`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'url_verification', challenge: 'abc', token: 'tok' }),
    })
    assert.equal(challenge.status, 200)
    assert.equal((await challenge.json() as { challenge: string }).challenge, 'abc')

    const badTok = await fetch(`${base}/api/feishu/events`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'url_verification', challenge: 'abc', token: 'nope' }),
    })
    assert.equal(badTok.status, 401)

    const login = await fetch(`${base}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'wang', password: '123456' }),
    })
    const cookie = login.headers.getSetCookie()[0].split(';')[0]
    const skillRes = await fetch(`${base}/api/agent-skill`, { method: 'POST', headers: { cookie } })
    assert.equal(skillRes.status, 200)
    const issued = (await skillRes.json()) as { filename: string; markdown: string }
    assert.equal(issued.filename, 'kb-web.SKILL.md')
    assert.match(issued.markdown, /Bearer kb_/)

    const gone = await fetch(`${base}/api/feishu/bind-code`, { method: 'POST', headers: { cookie } })
    assert.equal(gone.status, 404)

    const adminLogin = await fetch(`${base}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'admin123' }),
    })
    const adminCookie = adminLogin.headers.getSetCookie()[0].split(';')[0]
    const list = await fetch(`${base}/api/admin/feishu/bindings`, { headers: { cookie: adminCookie } })
    assert.equal(list.status, 404)
  } finally {
    await server.close()
    rmSync(dir, { recursive: true, force: true })
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
  }
})
