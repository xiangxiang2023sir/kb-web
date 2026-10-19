import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import assert from 'node:assert/strict'
import { WebSocket } from 'ws'
import { canSee, parseSlug } from '../src/access.js'
import { confidenceOf } from '../src/config.js'
import { decodeUploadName, extractText, isSmallTalk, searchQueryOf, searchTermsOf } from '../src/text.js'
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

test('打招呼不走知识库检索', () => {
  const phrases = ['你好', '您好', '谢谢', '你是谁', 'hi']
  assert.equal(isSmallTalk('你好', phrases), true)
  assert.equal(isSmallTalk('你好呀！', phrases), true)
  assert.equal(isSmallTalk('谢谢你', phrases), true)
  assert.equal(isSmallTalk('Hi', phrases), true)
  assert.equal(isSmallTalk('你是谁', phrases), true)
  assert.equal(isSmallTalk('液压油多久换一次', phrases), false)
  assert.equal(isSmallTalk('你好，液压油怎么换', phrases), false)
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

test('上传文件名的 UTF-8 乱码能还原成中文', () => {
  const garbled = Buffer.from('保养规程.xlsm', 'utf8').toString('latin1')
  assert.equal(decodeUploadName(garbled), '保养规程.xlsm')
  assert.equal(decodeUploadName('保养规程.xlsm'), '保养规程.xlsm')
  assert.equal(decodeUploadName('report.xlsx'), 'report.xlsx')
})

test('xlsm 按表格抽出文字', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'kb-xlsm-'))
  const path = join(dir, '保养.xlsm')
  try {
    const xlsx = await import('xlsx')
    const book = xlsx.utils.book_new()
    xlsx.utils.book_append_sheet(book, xlsx.utils.aoa_to_sheet([['液压油', '2000小时']]), '规程')
    xlsx.writeFile(book, path, { bookType: 'xlsm' })
    const text = await extractText(path, '保养.xlsm')
    assert.match(text, /液压油/)
    assert.match(text, /2000小时/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
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
  // 空字符串：loadEnvFile 不会用 server/.env 覆盖已有变量
  process.env.DEEPSEEK_API_KEY = ''
  // 本机 server/.env 里可能有真实的 GBRAIN_BIN，测试必须用 fake，且要先于 start() 里的 loadEnvFile
  process.env.GBRAIN_BIN = 'node'
  process.env.AGENT_TOKENS = 'tester:test-token-123'
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

    // ---- 原件留存：服务器上能下载，页面里登记，权限跟密级走 ----
    const detail = await fetch(`${base}/api/admin/docs/${doc.id}`, { headers: { cookie } })
    assert.equal(detail.status, 200)
    assert.equal((await detail.json()).hasOriginal, true)

    const original = await fetch(`${base}/api/admin/docs/${doc.id}/original`, { headers: { cookie } })
    assert.equal(original.status, 200)
    assert.match(original.headers.get('content-disposition') ?? '', /filename\*=UTF-8''/)
    assert.ok((await original.text()).includes('绝缘电阻'))

    // 这份是 top_secret，admin 不能下
    const deniedOriginal = await fetch(`${base}/api/admin/docs/${doc.id}/original`, { headers: { cookie: adminCookie } })
    assert.equal(deniedOriginal.status, 403)

    // 入库的页面里应登记原件名（迁移时能顺藤摸到原件）
    const corpusFiles = (readdirSync(join(dir, 'corpus'), { recursive: true }) as string[]).filter((f) => f.endsWith('.md'))
    assert.ok(corpusFiles.length > 0)
    const pageText = readFileSync(join(dir, 'corpus', corpusFiles[0]), 'utf8')
    assert.ok(pageText.includes('**原件**'), '页面应登记原件')

    const adminUsers = await fetch(`${base}/api/admin/users`, { headers: { cookie: adminCookie } })
    assert.equal(adminUsers.status, 200)
    assert.ok(Array.isArray(await adminUsers.json()))
    const adminCreate = await fetch(`${base}/api/admin/users`, {
      method: 'POST',
      headers: { cookie: adminCookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'x', password: '1', role: 'operator', field: 'electrical' }),
    })
    assert.equal(adminCreate.status, 403)

    const events = await ask(base, cookie, '空结果')
    assert.ok(events.some((e) => e.type === 'status' && e.phase === 'no_evidence'))
    assert.ok(events.some((e) => e.type === 'done'))
    assert.ok(events.some((e) => e.type === 'session' && typeof e.sessionId === 'string'))

    // agent 写入接口：token 校验 + 只写待确认
    const noToken = await fetch(`${base}/api/agent/capture`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'x', content: 'y' }),
    })
    assert.equal(noToken.status, 401)

    const badToken = await fetch(`${base}/api/agent/capture`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer wrong' },
      body: JSON.stringify({ title: 'x', content: 'y' }),
    })
    assert.equal(badToken.status, 401)

    const noContent = await fetch(`${base}/api/agent/capture`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test-token-123' },
      body: JSON.stringify({ title: '只有标题' }),
    })
    assert.equal(noContent.status, 400)

    const agentIn = await fetch(`${base}/api/agent/capture`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test-token-123' },
      body: JSON.stringify({ title: 'agent 写入测试', content: '现场经验一条', field: 'electrical', kind: '经验' }),
    })
    assert.equal(agentIn.status, 200)
    const agentBody = (await agentIn.json()) as { id: string; status: string; title: string }
    assert.equal(agentBody.status, 'pending')
    assert.ok(agentBody.title.startsWith('[经验]'))

    // 同标题第二次应去重
    const agentAgain = await fetch(`${base}/api/agent/capture`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test-token-123' },
      body: JSON.stringify({ title: 'agent 写入测试', content: '现场经验一条', field: 'electrical', kind: '经验' }),
    })
    assert.equal((await agentAgain.json()).duplicate, true)

    // 通用绑定 + 外部 agent 检索（带权限过滤）
    const bc = await fetch(`${base}/api/bind-code`, { method: 'POST', headers: { cookie } })
    assert.equal(bc.status, 200)
    const bindCode = ((await bc.json()) as { code: string }).code
    assert.ok(bindCode && bindCode.length >= 4)

    // 未绑定身份先检索 → 403
    const unbound = await fetch(`${base}/api/agent/search`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test-token-123' },
      body: JSON.stringify({ query: '变频器', channel: 'teams', external_id: 'nobody@example.com' }),
    })
    assert.equal(unbound.status, 403)

    // 用码绑定 Teams 身份
    const bindRes = await fetch(`${base}/api/agent/bind`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test-token-123' },
      body: JSON.stringify({ code: bindCode, channel: 'teams', external_id: 'norman@example.com' }),
    })
    assert.equal(bindRes.status, 200)

    // 绑定后检索：只回命中/无依据文案，不生成答案
    const searchRes = await fetch(`${base}/api/agent/search`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test-token-123' },
      body: JSON.stringify({ query: '变频器', channel: 'teams', external_id: 'norman@example.com' }),
    })
    assert.equal(searchRes.status, 200)
    const searchBody = (await searchRes.json()) as { hits: unknown[]; noEvidence: string | null }
    assert.ok(Array.isArray(searchBody.hits))
    assert.ok(!('answer' in (searchBody as Record<string, unknown>)), '不该返回生成答案')

    // 绑定码一次性：再用一次应失败
    const reuse = await fetch(`${base}/api/agent/bind`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test-token-123' },
      body: JSON.stringify({ code: bindCode, channel: 'teams', external_id: 'other@example.com' }),
    })
    assert.equal(reuse.status, 400)

    const told = await ask(base, cookie, '我改成了 0.5 米每秒，记录一下')
    assert.ok(told.some((e) => e.type === 'status' && e.phase === 'acknowledged'), '告知应走确认分支')
    assert.ok(!told.some((e) => e.type === 'citation'), '告知不应检索出引用')
    assert.ok(told.some((e) => e.type === 'done'))

    const saved = await fetch(`${base}/api/chat/save-to-kb`, {
      method: 'POST',
      headers: { cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ question: '现场参数', answer: '行走速度改成 0.5 m/s', citations: [] }),
    })
    assert.equal(saved.status, 200)
    assert.equal((await saved.json()).ok, true)
    const pending = await fetch(`${base}/api/admin/docs?status=pending`, { headers: { cookie } })
    const pendingBody = (await pending.json()) as { list: { title: string }[]; total: number }
    assert.ok(pendingBody.list.some((d) => d.title.startsWith('[对话沉淀]')), '对话沉淀应进待确认')

    const hi = await ask(base, cookie, '你好')
    assert.ok(!hi.some((e) => e.type === 'status' && e.phase === 'no_evidence'))
    assert.ok(hi.some((e) => e.type === 'delta'))
    assert.ok(hi.some((e) => e.type === 'done'))
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
