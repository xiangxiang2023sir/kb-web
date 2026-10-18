import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import assert from 'node:assert/strict'
import { WebSocket } from 'ws'
import { canSee, parseSlug } from '../src/access.js'
import { confidenceOf } from '../src/config.js'
import { searchQueryOf, searchTermsOf } from '../src/text.js'
import { start } from '../src/app.js'

const fakeGbrain = fileURLToPath(new URL('./fake-gbrain.mjs', import.meta.url))

test('slug 前缀决定能不能看', () => {
  const owner = { id: 'u1', name: 'owner', role: 'owner' as const, field: null }
  const admin = { id: 'u2', name: 'admin', role: 'admin' as const, field: null }
  const wang = { id: 'u3', name: 'wang', role: 'operator' as const, field: 'electrical' as const }
  const guest = { id: 'guest', name: '游客', role: 'guest' as const, field: null }
  assert.equal(parseSlug('notes/todo'), null)
  assert.equal(canSee(owner, 'mechanical', 'top_secret'), true)
  assert.equal(canSee(admin, 'mechanical', 'top_secret'), false)
  assert.equal(canSee(admin, 'mechanical', 'confidential'), true)
  assert.equal(canSee(wang, 'electrical', 'internal'), true)
  assert.equal(canSee(wang, 'mechanical', 'public'), false)
  assert.equal(canSee(guest, 'electrical', 'public'), true)
  assert.equal(canSee(guest, 'electrical', 'internal'), false)
})

test('疑问说法不进入检索词', () => {
  const phrases = ['怎么处理', '如何处理', '怎么办', '如何', '是什么']
  assert.equal(searchQueryOf('变频器过载怎么处理', phrases), '变频器过载')
  assert.equal(searchQueryOf('如何处理变频器过载？', phrases), '变频器过载')
  assert.equal(searchQueryOf('润滑油是什么', phrases), '润滑油')
  assert.equal(searchQueryOf('怎么处理', phrases), '怎么处理')
  assert.equal(searchQueryOf('F009', phrases), 'F009')
})

test('检索词切分成 GBrain 能或匹配的词组', () => {
  // 中文长句：整段保留，另补二字组、三字组
  const terms = searchTermsOf('液压油多久换一次').split(' ')
  for (const expected of ['液压油多久换一次', '液压油', '液压', '压油', '多久', '一次']) {
    assert.ok(terms.includes(expected), `缺少 ${expected}`)
  }
  // 字母数字段原样保留，不切碎
  assert.equal(searchTermsOf('F009'), 'F009')
  assert.ok(searchTermsOf('F009 报警').split(' ').includes('F009'))
  // 已有空格的词各自成段
  const two = searchTermsOf('变频器 过载').split(' ')
  assert.ok(two.includes('变频器') && two.includes('过载'))
  // 单字噪音丢弃；整句只有一个字时保留
  assert.equal(searchTermsOf('液压油 吗'), searchTermsOf('液压油'))
  assert.equal(searchTermsOf('油'), '油')
  assert.equal(searchTermsOf(''), '')
})

test('置信度分数压到 0–1，大分仍算充分', () => {
  const cfg = { highMin: 0.03, mediumMin: 0.015 }
  assert.deepEqual(confidenceOf(5008, { confidence: cfg } as never), { level: 'high', score: 1 })
  assert.deepEqual(confidenceOf(0.05, { confidence: cfg } as never), { level: 'high', score: 0.05 })
  assert.deepEqual(confidenceOf(0.02, { confidence: cfg } as never), { level: 'medium', score: 0.02 })
  assert.deepEqual(confidenceOf(0.01, { confidence: cfg } as never), { level: 'low', score: 0.01 })
})

test('登录、入库和依据不足', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'kb-'))
  writeFileSync(
    join(dir, 'config.yaml'),
    `search: { fetchLimit: 10, keep: 5, maxPages: 1 }
confidence: { highMin: 0.03, mediumMin: 0.015 }
noEvidence: { text: "没有资料", score: 0.2 }
keywords: { electrical: [变频], mechanical: [], dispatch: [] }
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
  process.env.KB_CONFIG = join(dir, 'config.yaml')
  delete process.env.DEEPSEEK_API_KEY
  // 本机 server/.env 里可能有真实的 GBRAIN_BIN，测试必须用 fake，且要先于 start() 里的 loadEnvFile
  process.env.GBRAIN_BIN = 'node'
  const server = await start({ dataDir: dir, port: 0, host: '127.0.0.1' })
  const base = `http://127.0.0.1:${server.port}`
  try {
    const anon = await fetch(`${base}/api/auth/me`)
    assert.equal(anon.status, 401)

    const login = await fetch(`${base}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'owner', password: 'admin123' }),
    })
    assert.equal(login.status, 200)
    const cookie = login.headers.getSetCookie()[0].split(';')[0]
    const me = await fetch(`${base}/api/auth/me`, { headers: { cookie } })
    assert.equal((await me.json()).role, 'owner')

    const upload = await fetch(`${base}/api/admin/docs/upload`, {
      method: 'POST',
      headers: { cookie, 'Content-Type': 'text/plain' },
    })
    assert.equal(upload.status, 400)

    const form = new FormData()
    form.set('file', new File(['绝缘电阻应不小于 0.5MΩ'], '变频器规程.txt', { type: 'text/plain' }))
    const created = await fetch(`${base}/api/admin/docs/upload`, { method: 'POST', headers: { cookie }, body: form })
    assert.equal(created.status, 200)
    const doc = (await created.json()) as { id: string; suggestedField: string }
    assert.equal(doc.suggestedField, 'electrical')

    const confirmed = await fetch(`${base}/api/admin/docs/${doc.id}/confirm`, {
      method: 'POST',
      headers: { cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ field: 'electrical', sensitivity: 'top_secret' }),
    })
    assert.equal(confirmed.status, 200)

    const adminLogin = await fetch(`${base}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'admin123' }),
    })
    const adminCookie = adminLogin.headers.getSetCookie()[0].split(';')[0]
    const forbidden = await fetch(`${base}/api/admin/docs/${doc.id}/confirm`, {
      method: 'POST',
      headers: { cookie: adminCookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ field: 'electrical', sensitivity: 'top_secret' }),
    })
    assert.equal(forbidden.status, 403)

    const events = await ask(base, cookie, '空结果')
    assert.ok(events.some((e) => e.type === 'status' && e.phase === 'no_evidence'))
    assert.ok(events.some((e) => e.type === 'done'))
    assert.ok(events.some((e) => e.type === 'session' && typeof e.sessionId === 'string'))
  } finally {
    await server.close()
    rmSync(dir, { recursive: true, force: true })
    delete process.env.KB_CONFIG
  }
})

function ask(base: string, cookie: string, question: string): Promise<Record<string, unknown>[]> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(base.replace('http', 'ws') + '/ws', { headers: { cookie } })
    const events: Record<string, unknown>[] = []
    const timer = setTimeout(() => {
      ws.close()
      reject(new Error('问答超时'))
    }, 5000)
    ws.on('open', () => ws.send(JSON.stringify({ type: 'ask', questionId: 'q1', question })))
    ws.on('message', (raw) => {
      const msg = JSON.parse(String(raw)) as Record<string, unknown>
      events.push(msg)
      if (msg.type === 'done' || msg.type === 'error') {
        clearTimeout(timer)
        ws.close()
        resolve(events)
      }
    })
    ws.on('error', (err) => {
      clearTimeout(timer)
      reject(err)
    })
  })
}
