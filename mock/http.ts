/**
 * Mock REST 接口（仅开发用）。
 * 实现 src/api/endpoints.ts 里的全部清单，挂在 Vite 开发/预览服务器的 /api 下。
 * 用 HttpOnly Cookie（mock_uid）模拟会话，登录/游客/刷新恢复都能走通。
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import {
  docs,
  guestUser,
  guessField,
  issues,
  publicUser,
  questions,
  sessions,
  uploads,
  users,
  type MockDoc,
  type MockUser,
} from './data'
import type { ChatAttachment, Field, QuestionItem, Sensitivity, UploadResult, User } from '../src/types/index'

// ---------- 工具 ----------

function sendJson(res: ServerResponse, status: number, data: unknown) {
  res.statusCode = status
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.end(JSON.stringify(data))
}

function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    let raw = ''
    req.on('data', (c) => (raw += c))
    req.on('end', () => {
      try {
        resolve(raw ? (JSON.parse(raw) as Record<string, unknown>) : {})
      } catch {
        resolve({})
      }
    })
  })
}

function readRaw(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => resolve(Buffer.concat(chunks)))
  })
}

function uidFromCookie(req: IncomingMessage): string | null {
  const cookie = req.headers.cookie ?? ''
  const m = /(?:^|;\s*)mock_uid=([^;]+)/.exec(cookie)
  return m ? decodeURIComponent(m[1]) : null
}

function currentUser(req: IncomingMessage): User | null {
  const uid = uidFromCookie(req)
  if (!uid) return null
  if (uid === guestUser.id) return publicUser(guestUser)
  const u = users.find((x) => x.id === uid)
  return u ? publicUser(u) : null
}

function setSessionCookie(res: ServerResponse, uid: string) {
  res.setHeader('Set-Cookie', `mock_uid=${encodeURIComponent(uid)}; Path=/; HttpOnly; SameSite=Lax`)
}

function clearSessionCookie(res: ServerResponse) {
  res.setHeader('Set-Cookie', 'mock_uid=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0')
}

function delay(ms: number) {
  return new Promise((r) => setTimeout(r, ms))
}

/**
 * 极简 multipart 解析：提取第一个带 filename 的文件段。
 * latin1 是逐字节编码，字符串与 Buffer 可无损互转，Mock 用足够。
 */
function parseMultipartFile(
  req: IncomingMessage,
  raw: Buffer,
): { name: string; mimeType: string; data: Buffer } | null {
  const ct = String(req.headers['content-type'] ?? '')
  const bm = /boundary=([^;]+)/.exec(ct)
  if (!bm) return null
  const boundary = bm[1].trim()
  const text = raw.toString('latin1')
  const seg = text.split(`--${boundary}`).find((s) => s.includes('filename="'))
  if (!seg) return null
  const headerEnd = seg.indexOf('\r\n\r\n')
  if (headerEnd < 0) return null
  const headers = seg.slice(0, headerEnd)
  let data = seg.slice(headerEnd + 4)
  if (data.endsWith('\r\n')) data = data.slice(0, -2)
  const name = /filename="([^"]*)"/.exec(headers)?.[1] ?? 'file'
  const mimeType = /Content-Type:\s*([^\r\n]+)/i.exec(headers)?.[1]?.trim() ?? 'application/octet-stream'
  return { name, mimeType, data: Buffer.from(data, 'latin1') }
}

// ---------- 路由表 ----------

type Role0 = 'open' | 'user' | 'admin' | 'owner'

interface Ctx {
  req: IncomingMessage
  res: ServerResponse
  params: Record<string, string>
  query: URLSearchParams
  user: User | null
}

interface Route {
  method: string
  pattern: string
  role?: Role0 // 默认 'user'
  handler: (ctx: Ctx) => void | Promise<void>
}

function match(pattern: string, path: string): Record<string, string> | null {
  const p = pattern.split('/').filter(Boolean)
  const a = path.split('/').filter(Boolean)
  if (p.length !== a.length) return null
  const params: Record<string, string> = {}
  for (let i = 0; i < p.length; i++) {
    if (p[i].startsWith(':')) params[p[i].slice(1)] = decodeURIComponent(a[i])
    else if (p[i] !== a[i]) return null
  }
  return params
}

let seq = 0
const nextId = (prefix: string) => `${prefix}-${Date.now()}-${++seq}`
const now = () => new Date().toISOString()

const routes: Route[] = [
  // ---------- 认证 ----------
  {
    method: 'POST',
    pattern: '/auth/login',
    role: 'open',
    handler: async ({ req, res }) => {
      await delay(300)
      const body = await readBody(req)
      const u = users.find((x) => x.name === body.username)
      if (!u || u.password !== body.password) {
        return sendJson(res, 401, { message: '用户名或密码错误' })
      }
      setSessionCookie(res, u.id)
      sendJson(res, 200, publicUser(u))
    },
  },
  {
    method: 'POST',
    pattern: '/auth/guest',
    role: 'open',
    handler: async ({ res }) => {
      await delay(200)
      setSessionCookie(res, guestUser.id)
      sendJson(res, 200, publicUser(guestUser))
    },
  },
  {
    method: 'POST',
    pattern: '/auth/logout',
    role: 'open',
    handler: ({ res }) => {
      clearSessionCookie(res)
      sendJson(res, 200, { ok: true })
    },
  },
  {
    method: 'GET',
    pattern: '/auth/me',
    role: 'open',
    handler: ({ user, res }) => {
      if (!user) return sendJson(res, 401, { message: '未登录' })
      sendJson(res, 200, user)
    },
  },

  // ---------- 会话 ----------
  {
    method: 'GET',
    pattern: '/chat/sessions',
    handler: ({ res }) => {
      sendJson(
        res,
        200,
        sessions.map(({ messages: _m, ...s }) => s),
      )
    },
  },
  {
    method: 'GET',
    pattern: '/chat/sessions/:id/messages',
    handler: ({ params, res }) => {
      const s = sessions.find((x) => x.id === params.id)
      if (!s) return sendJson(res, 404, { message: '会话不存在' })
      sendJson(res, 200, s.messages)
    },
  },

  // ---------- 聊天照片 ----------
  {
    method: 'POST',
    pattern: '/chat/uploads',
    handler: async ({ req, res }) => {
      const f = parseMultipartFile(req, await readRaw(req))
      if (!f) return sendJson(res, 400, { message: '未收到文件' })
      const id = nextId('img')
      uploads.set(id, f)
      const result: ChatAttachment = {
        id,
        url: `/api/chat/uploads/${id}`,
        name: f.name,
        mimeType: f.mimeType,
        size: f.data.length,
      }
      sendJson(res, 200, result)
    },
  },
  {
    method: 'GET',
    pattern: '/chat/uploads/:id',
    handler: ({ params, res }) => {
      const u = uploads.get(params.id)
      if (!u) {
        res.statusCode = 404
        return res.end('not found')
      }
      res.statusCode = 200
      res.setHeader('Content-Type', u.mimeType)
      res.setHeader('Cache-Control', 'private, max-age=3600')
      res.end(u.data)
    },
  },

  // ---------- 问题队列（用户侧） ----------
  {
    method: 'POST',
    pattern: '/questions',
    handler: async ({ req, user, res }) => {
      const body = await readBody(req)
      const question = String(body.question ?? '')
      const item: QuestionItem = {
        id: nextId('q'),
        question,
        askedBy: user?.name ?? 'unknown',
        field: guessField(question),
        status: 'open',
        createdAt: now(),
      }
      questions.unshift(item)
      sendJson(res, 200, { id: item.id })
    },
  },
  {
    method: 'GET',
    pattern: '/questions/mine',
    handler: ({ user, res }) => {
      sendJson(res, 200, questions.filter((q) => q.askedBy === user?.name))
    },
  },

  {
    method: 'POST',
    pattern: '/feishu/bind-code',
    handler: ({ res }) => {
      const code = Math.random().toString(16).slice(2, 8).toUpperCase().padEnd(6, 'A')
      sendJson(res, 200, { code, expiresIn: 300 })
    },
  },

  // ---------- 管理端 ----------
  {
    method: 'GET',
    pattern: '/admin/overview',
    role: 'admin',
    handler: ({ res }) => {
      sendJson(res, 200, {
        pendingDocs: docs.filter((d) => d.status === 'pending').length,
        unassignedQuestions: questions.filter((q) => q.status === 'open').length,
        failedChecks: issues.length,
        todayQuestions: 23,
      })
    },
  },
  {
    method: 'GET',
    pattern: '/admin/docs',
    role: 'admin',
    handler: ({ query, res }) => {
      let list = docs.slice()
      const keyword = query.get('keyword')
      const field = query.get('field')
      const sensitivity = query.get('sensitivity')
      const status = query.get('status')
      if (keyword) list = list.filter((d) => d.title.includes(keyword))
      if (field) list = list.filter((d) => d.field === field)
      if (sensitivity) list = list.filter((d) => d.sensitivity === sensitivity)
      if (status) list = list.filter((d) => d.status === status)
      const page = Number(query.get('page') ?? 1)
      const size = Number(query.get('size') ?? 20)
      const total = list.length
      const items = list.slice((page - 1) * size, page * size).map(({ content: _c, referencedBy: _r, ...d }) => d)
      sendJson(res, 200, { list: items, total })
    },
  },
  {
    method: 'GET',
    pattern: '/admin/docs/:id',
    role: 'admin',
    handler: ({ params, res }) => {
      const d = docs.find((x) => x.id === params.id)
      if (!d) return sendJson(res, 404, { message: '文档不存在' })
      sendJson(res, 200, d)
    },
  },
  {
    method: 'POST',
    pattern: '/admin/docs/upload',
    role: 'admin',
    handler: async ({ req, res }) => {
      // 模拟 Hermes 解析 + 自动分类
      await delay(900)
      const raw = (await readRaw(req)).toString('latin1')
      const m = /filename="([^"]+)"/.exec(raw)
      const filename = m?.[1] ?? '未命名文档'
      const ext = filename.includes('.') ? filename.slice(filename.lastIndexOf('.')).toLowerCase() : ''
      if (!['.pdf', '.docx', '.xlsx', '.xls', '.xlsm', '.md', '.txt'].includes(ext)) {
        return sendJson(res, 400, { message: '只支持 pdf、docx、xlsx、xls、xlsm、md、txt' })
      }
      const title = filename.replace(/\.[^.]+$/, '')
      const suggestedField = guessField(filename)
      const suggestedSensitivity: Sensitivity = 'internal'
      const doc: MockDoc = {
        id: nextId('d'),
        title,
        field: suggestedField,
        sensitivity: suggestedSensitivity,
        status: 'pending',
        suggestedField,
        suggestedSensitivity,
        updatedAt: now(),
        content: `（Mock 解析出的《${title}》正文占位）`,
        referencedBy: [],
      }
      docs.unshift(doc)
      const result: UploadResult = { id: doc.id, title, suggestedField, suggestedSensitivity }
      sendJson(res, 200, result)
    },
  },
  {
    method: 'POST',
    pattern: '/admin/docs/:id/confirm',
    role: 'admin',
    handler: async ({ req, params, res }) => {
      const body = await readBody(req)
      const d = docs.find((x) => x.id === params.id)
      if (!d) return sendJson(res, 404, { message: '文档不存在' })
      // 模拟 gbrain put 入库
      d.status = 'confirmed'
      d.field = (body.field as Field) ?? d.field
      d.sensitivity = (body.sensitivity as Sensitivity) ?? d.sensitivity
      d.updatedAt = now()
      sendJson(res, 200, { ok: true })
    },
  },
  {
    method: 'POST',
    pattern: '/admin/docs/:id/reject',
    role: 'admin',
    handler: async ({ req, params, res }) => {
      const body = await readBody(req)
      const d = docs.find((x) => x.id === params.id)
      if (!d) return sendJson(res, 404, { message: '文档不存在' })
      d.status = 'rejected'
      d.rejectReason = String(body.reason ?? '')
      d.updatedAt = now()
      sendJson(res, 200, { ok: true })
    },
  },
  {
    method: 'GET',
    pattern: '/admin/health/issues',
    role: 'admin',
    handler: ({ res }) => sendJson(res, 200, issues),
  },
  {
    method: 'POST',
    pattern: '/admin/health/run',
    role: 'admin',
    handler: async ({ res }) => {
      // 模拟 gbrain find_orphans / find_anomalies
      await delay(1200)
      sendJson(res, 200, { ok: true })
    },
  },
  {
    method: 'GET',
    pattern: '/admin/questions',
    role: 'admin',
    handler: ({ query, res }) => {
      let list = questions.slice()
      const field = query.get('field')
      const status = query.get('status')
      if (field) list = list.filter((q) => q.field === field)
      if (status) list = list.filter((q) => q.status === status)
      sendJson(res, 200, list)
    },
  },
  {
    method: 'GET',
    pattern: '/admin/questions/:id',
    role: 'admin',
    handler: ({ params, res }) => {
      const q = questions.find((x) => x.id === params.id)
      if (!q) return sendJson(res, 404, { message: '问题不存在' })
      sendJson(res, 200, {
        ...q,
        context: '（Mock）提问时的对话上下文：用户在对话中连续追问了两次，AI 均未检索到相关资料。',
      })
    },
  },
  {
    method: 'POST',
    pattern: '/admin/questions/:id/assign',
    role: 'admin',
    handler: async ({ req, params, res }) => {
      const body = await readBody(req)
      const q = questions.find((x) => x.id === params.id)
      if (!q) return sendJson(res, 404, { message: '问题不存在' })
      const assignee = users.find((x) => x.id === body.userId)
      q.assignee = assignee?.name ?? String(body.userId ?? '')
      q.status = 'assigned'
      sendJson(res, 200, { ok: true })
    },
  },
  {
    method: 'POST',
    pattern: '/admin/questions/:id/resolve',
    role: 'admin',
    handler: async ({ req, params, res }) => {
      const body = await readBody(req)
      const q = questions.find((x) => x.id === params.id)
      if (!q) return sendJson(res, 404, { message: '问题不存在' })
      q.status = 'resolved'
      // 解答转入待确认队列，模拟「入库前人工确认」
      docs.unshift({
        id: nextId('d'),
        title: String(body.title ?? q.question).slice(0, 60),
        field: (body.field as Field) ?? q.field,
        sensitivity: (body.sensitivity as Sensitivity) ?? 'internal',
        status: 'pending',
        suggestedField: q.field,
        suggestedSensitivity: 'internal',
        updatedAt: now(),
        content: String(body.answer ?? ''),
        referencedBy: [],
      })
      sendJson(res, 200, { ok: true })
    },
  },
  {
    method: 'GET',
    pattern: '/admin/users',
    role: 'admin',
    handler: ({ res }) => sendJson(res, 200, users.map(publicUser)),
  },
  {
    method: 'POST',
    pattern: '/admin/users',
    role: 'owner',
    handler: async ({ req, res }) => {
      const body = await readBody(req)
      const name = String(body.name ?? '').trim()
      if (!name) return sendJson(res, 400, { message: '用户名不能为空' })
      if (users.some((x) => x.name === name)) return sendJson(res, 400, { message: '用户名已存在' })
      const u: MockUser = {
        id: nextId('u'),
        name,
        password: String(body.password ?? '123456'),
        role: (body.role as User['role']) ?? 'operator',
        field: (body.field as Field | null) ?? null,
      }
      users.push(u)
      sendJson(res, 200, publicUser(u))
    },
  },
  {
    method: 'PATCH',
    pattern: '/admin/users/:id',
    role: 'owner',
    handler: async ({ req, params, res }) => {
      const body = await readBody(req)
      const u = users.find((x) => x.id === params.id)
      if (!u) return sendJson(res, 404, { message: '用户不存在' })
      if (body.role) u.role = body.role as User['role']
      if ('field' in body) u.field = (body.field as Field | null) ?? null
      sendJson(res, 200, publicUser(u))
    },
  },
]

// ---------- 中间件入口 ----------

export async function mockApiMiddleware(
  req: IncomingMessage,
  res: ServerResponse,
  next: () => void,
) {
  const url = new URL(req.url ?? '/', 'http://mock')
  const path = url.pathname
  const route = routes.find((r) => r.method === req.method && match(r.pattern, path))
  if (!route) {
    // /api 下未实现的接口直接 404，避免落到 SPA 的 index.html
    return sendJson(res, 404, { message: `Mock 未实现：${req.method} ${path}` })
  }

  const user = currentUser(req)
  const role: Role0 = route.role ?? 'user'
  if (role !== 'open' && !user) return sendJson(res, 401, { message: '未登录' })
  if (role === 'admin' && !(user!.role === 'admin' || user!.role === 'owner')) {
    return sendJson(res, 403, { message: '无权限' })
  }
  if (role === 'owner' && user!.role !== 'owner') return sendJson(res, 403, { message: '仅主人可用' })

  await route.handler({ req, res, params: match(route.pattern, path)!, query: url.searchParams, user })
}
