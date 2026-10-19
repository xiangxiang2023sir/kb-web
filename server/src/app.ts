import { createServer, type IncomingMessage } from 'node:http'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import express, { type NextFunction, type Request, type Response } from 'express'
import Busboy from 'busboy'
import { WebSocketServer, type WebSocket } from 'ws'
import { assertCanConfirm, parseSlug } from './access.js'
import { cancelAll, cancelAsk, contextOf, handleAsk } from './ask.js'
import { loadConfig, loadEnvFile, serverRoot, type AppConfig, type Field, type Role, type Sensitivity, type User, isField, isRole, isSensitivity } from './config.js'
import { hashPassword, KbDb, newId, openDb, verifyPassword } from './db.js'
import { GBrainError, captureGBrain, listGBrain } from './gbrain.js'
import { runHealth } from './health.js'
import { classifyText } from './llm.js'
import {
  challengeOf,
  eventPayload,
  feishuConfigured,
  handleFeishuEvent,
  issueBindCode,
  parseFeishuBody,
  replyFeishu,
  verifyFeishuRequest,
} from './feishu.js'
import { asciiSlug, decodeUploadName, extractText, guessField, guessSensitivity, toMarkdown } from './text.js'

interface AppLocals {
  user?: User
}

function cookieOf(req: IncomingMessage, name: string): string | null {
  const raw = req.headers.cookie ?? ''
  const match = new RegExp(`(?:^|;\\s*)${name}=([^;]+)`).exec(raw)
  return match ? decodeURIComponent(match[1]) : null
}

function setCookie(res: Response, name: string, value: string, maxAge: number) {
  const base = `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax`
  res.setHeader('Set-Cookie', maxAge >= 0 ? `${base}; Max-Age=${maxAge}` : `${base}; Max-Age=0`)
}

class HttpError extends Error {
  status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

function asyncRoute(fn: (req: Request, res: Response) => Promise<void>) {
  return (req: Request, res: Response, next: NextFunction) => {
    fn(req, res).catch(next)
  }
}

interface UploadFile {
  name: string
  mime: string
  data: Buffer
}

function readMultipart(req: IncomingMessage, maxBytes: number): Promise<UploadFile> {
  return new Promise((resolve, reject) => {
    let busboy: Busboy.Busboy
    try {
      busboy = Busboy({
        headers: req.headers,
        limits: { files: 1, fileSize: maxBytes },
        defParamCharset: 'utf8',
      })
    } catch {
      reject(new HttpError(400, '未收到文件'))
      return
    }
    let file: UploadFile | null = null
    let tooBig = false
    busboy.on('file', (_name, stream, info) => {
      const chunks: Buffer[] = []
      stream.on('data', (chunk: Buffer) => chunks.push(chunk))
      stream.on('limit', () => {
        tooBig = true
      })
      stream.on('end', () => {
        file = {
          name: decodeUploadName(info.filename || 'file'),
          mime: info.mimeType || 'application/octet-stream',
          data: Buffer.concat(chunks),
        }
      })
    })
    busboy.on('error', () => reject(new HttpError(400, '未收到文件')))
    busboy.on('finish', () => {
      if (tooBig) reject(new HttpError(400, '文件超过大小限制'))
      else if (!file || file.data.length === 0) reject(new HttpError(400, '未收到文件'))
      else resolve(file)
    })
    req.pipe(busboy)
  })
}

function safeName(name: string): string {
  return name.split(/[/\\]/).pop()!.replace(/[^\w.\-\u4e00-\u9fff]+/g, '_') || 'file'
}

const IMAGE_MIME = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp'])

export interface Started {
  port: number
  close: () => Promise<void>
}

export async function start(opts?: { dataDir?: string; port?: number; host?: string }): Promise<Started> {
  loadEnvFile()
  const config = loadConfig()
  const dataDir = opts?.dataDir ?? join(serverRoot, 'data')
  mkdirSync(dataDir, { recursive: true })
  const db = openDb(join(dataDir, 'kb.sqlite'))
  db.repairTitles(decodeUploadName)
  for (const doc of db.confirmedDocs()) {
    const parsed = parseSlug(doc.slug)
    if (!parsed) continue
    const markdown = toMarkdown(doc.title, parsed.field, parsed.sensitivity, doc.content)
    const corpus = join(dataDir, 'corpus', `${doc.slug}.md`)
    let current = ''
    try {
      current = readFileSync(corpus, 'utf8')
    } catch {
      /* 还没有语料文件 */
    }
    if (current === markdown) continue
    mkdirSync(dirname(corpus), { recursive: true })
    writeFileSync(corpus, markdown, 'utf8')
    try {
      await captureGBrain(config, corpus, doc.slug)
    } catch {
      // 启动时把 GBrain 页标题改回来，失败不挡服务
    }
  }
  const app = express()
  app.use(
    express.json({
      limit: '2mb',
      verify: (req, _res, buf) => {
        ;(req as Request & { rawBody?: Buffer }).rawBody = Buffer.from(buf)
      },
    }),
  )

  app.use((req, res, next) => {
    const sid = cookieOf(req, config.auth.cookieName)
    if (sid) {
      const user = db.authUser(sid)
      if (user) (res.locals as AppLocals).user = user
    }
    next()
  })

  const userOf = (res: Response) => (res.locals as AppLocals).user

  const requireUser = (req: Request, res: Response, next: NextFunction) => {
    if (!userOf(res)) return res.status(401).json({ message: '未登录' })
    next()
  }
  const requireAdmin = (req: Request, res: Response, next: NextFunction) => {
    const user = userOf(res)
    if (!user) return res.status(401).json({ message: '未登录' })
    if (user.role !== 'admin' && user.role !== 'owner') return res.status(403).json({ message: '无权限' })
    next()
  }
  const requireOwner = (req: Request, res: Response, next: NextFunction) => {
    const user = userOf(res)
    if (!user) return res.status(401).json({ message: '未登录' })
    if (user.role !== 'owner') return res.status(403).json({ message: '仅主人可用' })
    next()
  }

  app.post(
    '/api/auth/login',
    asyncRoute(async (req, res) => {
      const name = String(req.body?.username ?? '')
      const password = String(req.body?.password ?? '')
      const found = db.findUserByName(name)
      if (!found?.passwordHash || !verifyPassword(password, found.passwordHash)) {
        throw new HttpError(401, '用户名或密码错误')
      }
      const sid = db.createAuthSession(found.id, config.auth.ttlDays)
      setCookie(res, config.auth.cookieName, sid, config.auth.ttlDays * 86400)
      const { passwordHash: _pw, ...user } = found
      res.json(user)
    }),
  )

  app.post('/api/auth/guest', (req, res) => {
    const sid = db.createAuthSession('guest', config.auth.ttlDays)
    setCookie(res, config.auth.cookieName, sid, config.auth.ttlDays * 86400)
    res.json({ id: 'guest', name: '游客', role: 'guest', field: null })
  })

  app.post('/api/auth/logout', (req, res) => {
    const sid = cookieOf(req, config.auth.cookieName)
    if (sid) db.deleteAuthSession(sid)
    setCookie(res, config.auth.cookieName, '', -1)
    res.json({ ok: true })
  })

  app.get('/api/auth/me', (req, res) => {
    const user = userOf(res)
    if (!user) return res.status(401).json({ message: '未登录' })
    res.json(user)
  })

  app.post('/api/feishu/events', (req, res) => {
    if (!feishuConfigured()) return res.status(503).json({ message: '未配置飞书' })
    const raw = (req as Request & { rawBody?: Buffer }).rawBody?.toString('utf8') ?? JSON.stringify(req.body ?? {})
    const headers = {
      'x-lark-request-timestamp': req.header('x-lark-request-timestamp') ?? undefined,
      'x-lark-request-nonce': req.header('x-lark-request-nonce') ?? undefined,
      'x-lark-signature': req.header('x-lark-signature') ?? undefined,
    }
    const check = verifyFeishuRequest(headers, raw)
    if (!check.ok) return res.status(check.status).json({ message: check.message })
    let parsed: Record<string, unknown>
    try {
      parsed = parseFeishuBody(raw, process.env.FEISHU_ENCRYPT_KEY ?? '')
    } catch {
      return res.status(400).json({ message: '无法解析' })
    }
    const challenge = challengeOf(parsed)
    if (challenge) return res.json({ challenge })
    res.json({ code: 0 })
    const payload = eventPayload(parsed)
    if (!payload || db.seenFeishuEvent(payload.eventId)) return
    void handleFeishuEvent(db, config, payload.event, replyFeishu).catch((err) => console.error('[feishu]', err))
  })

  app.post('/api/feishu/bind-code', requireUser, (_req, res) => {
    res.json(issueBindCode(db, userOf(res)!.id))
  })

  app.get('/api/admin/feishu/bindings', requireAdmin, (_req, res) => {
    res.json(db.listFeishuBindings())
  })

  app.delete(
    '/api/admin/feishu/bindings/:openId',
    requireAdmin,
    (req, res) => {
      db.unbindFeishu(req.params.openId)
      res.json({ ok: true })
    },
  )

  app.get('/api/chat/sessions', requireUser, (req, res) => {
    res.json(db.listChatSessions(userOf(res)!.id))
  })

  app.get(
    '/api/chat/sessions/:id/messages',
    requireUser,
    asyncRoute(async (req, res) => {
      const session = db.getChatSession(req.params.id, userOf(res)!.id)
      if (!session) throw new HttpError(404, '会话不存在')
      res.json(db.listMessages(req.params.id))
    }),
  )

  app.post(
    '/api/chat/uploads',
    requireUser,
    asyncRoute(async (req, res) => {
      const file = await readMultipart(req, config.limits.imageBytes)
      if (!IMAGE_MIME.has(file.mime)) throw new HttpError(400, '只能上传图片')
      const id = newId('img')
      const dir = join(dataDir, 'uploads')
      mkdirSync(dir, { recursive: true })
      const path = join(dir, `${id}-${safeName(file.name)}`)
      writeFileSync(path, file.data)
      const createdAt = new Date().toISOString()
      db.insertUpload({ id, userId: userOf(res)!.id, name: file.name, mime: file.mime, size: file.data.length, path, createdAt })
      res.json({ id, url: `/api/chat/uploads/${id}`, name: file.name, mimeType: file.mime, size: file.data.length })
    }),
  )

  app.get('/api/chat/uploads/:id', requireUser, (req, res) => {
    const row = db.getUpload(req.params.id)
    const user = userOf(res)!
    if (!row || (row.userId !== user.id && user.role !== 'owner' && user.role !== 'admin')) {
      return res.status(404).end('not found')
    }
    res.setHeader('Content-Type', row.mime)
    res.setHeader('Cache-Control', 'private, max-age=3600')
    res.end(readUploadFile(row.path))
  })

  app.post(
    '/api/questions',
    requireUser,
    asyncRoute(async (req, res) => {
      const user = userOf(res)!
      const question = String(req.body?.question ?? '').trim()
      if (!question) throw new HttpError(400, '问题不能为空')
      const sessionId = req.body?.sessionId ? String(req.body.sessionId) : undefined
      const id = newId('q')
      db.insertQuestion({
        id,
        question,
        askedBy: user.name,
        askedById: user.id,
        field: guessField(question, config),
        status: 'open',
        sessionId,
        context: contextOf(db, sessionId, user.id),
        createdAt: new Date().toISOString(),
      })
      res.json({ id })
    }),
  )

  app.get('/api/questions/mine', requireUser, (req, res) => {
    res.json(db.listQuestions({ askedById: userOf(res)!.id }))
  })

  app.get('/api/admin/overview', requireAdmin, (_req, res) => {
    res.json(db.overview())
  })

  app.get('/api/admin/docs', requireAdmin, (req, res) => {
    const user = userOf(res)!
    const page = Math.max(1, Number(req.query.page ?? 1))
    const size = Math.max(1, Number(req.query.size ?? 20))
    const list = db.listDocs({
      keyword: req.query.keyword ? String(req.query.keyword) : undefined,
      field: req.query.field ? String(req.query.field) : undefined,
      sensitivity: req.query.sensitivity ? String(req.query.sensitivity) : undefined,
      status: req.query.status ? String(req.query.status) : undefined,
      hideTopSecret: user.role !== 'owner',
    })
    res.json({ list: list.slice((page - 1) * size, page * size).map(({ slug: _s, ...item }) => item), total: list.length })
  })

  // 同步 GBrain 已入库页面到 sqlite 登记表（只登记元数据，不存正文）
  app.post(
    '/api/admin/docs/sync',
    requireAdmin,
    asyncRoute(async (_req, res) => {
      const pages = await listGBrain(config)
      let synced = 0
      let skipped = 0
      for (const page of pages) {
        // 检查是否已登记
        const existing = db.findDocBySlug(page.slug)
        if (existing) {
          skipped++
          continue
        }
        // 从 slug 解析领域和密级: 领域/密级/名字
        const parts = page.slug.split('/')
        const field = isField(parts[0]) ? parts[0] : 'dispatch'
        const sensitivity = isSensitivity(parts[1]) ? parts[1] : 'internal'
        db.insertDoc({
          id: newId('doc'),
          title: page.title,
          field,
          sensitivity,
          status: 'confirmed',
          suggestedField: field,
          suggestedSensitivity: sensitivity,
          content: '', // 正文不存，用时从 GBrain 取
          updatedAt: new Date().toISOString(),
          sourcePath: page.slug,
        })
        synced++
      }
      res.json({ synced, skipped, total: pages.length })
    }),
  )

  app.get(
    '/api/admin/docs/:id',
    requireAdmin,
    asyncRoute(async (req, res) => {
      const doc = db.getDoc(req.params.id)
      if (!doc) throw new HttpError(404, '文档不存在')
      if (doc.sensitivity === 'top_secret' && userOf(res)!.role !== 'owner') throw new HttpError(403, '无权限')
      const { slug: _s, sourcePath: _p, ...detail } = doc
      res.json(detail)
    }),
  )

  app.post(
    '/api/admin/docs/upload',
    requireAdmin,
    asyncRoute(async (req, res) => {
      const file = await readMultipart(req, config.limits.docBytes)
      const id = newId('d')
      const dir = join(dataDir, 'inbox')
      mkdirSync(dir, { recursive: true })
      const path = join(dir, `${id}-${safeName(file.name)}`)
      writeFileSync(path, file.data)
      const text = (await extractText(path, file.name)).trim()
      if (!text) throw new HttpError(400, '没有解析出正文')
      const title = file.name.replace(/\.[^.]+$/, '') || '未命名文档'
      const ai = await classifyText(config, `${title}\n${text}`)
      const suggestedField = ai?.field ?? guessField(`${title}\n${text}`, config)
      const suggestedSensitivity = ai?.sensitivity ?? guessSensitivity(`${title}\n${text}`, config)
      db.insertDoc({
        id,
        title,
        field: suggestedField,
        sensitivity: suggestedSensitivity,
        status: 'pending',
        suggestedField,
        suggestedSensitivity,
        content: text,
        updatedAt: new Date().toISOString(),
        sourcePath: path,
      })
      res.json({ id, title, suggestedField, suggestedSensitivity })
    }),
  )

  app.post(
    '/api/admin/docs/:id/confirm',
    requireAdmin,
    asyncRoute(async (req, res) => {
      const doc = db.getDoc(req.params.id)
      if (!doc) throw new HttpError(404, '文档不存在')
      const field = req.body?.field
      const sensitivity = req.body?.sensitivity
      if (!isField(field) || !isSensitivity(sensitivity)) throw new HttpError(400, '领域或密级不正确')
      assertCanConfirm(userOf(res)!, sensitivity)
      const slug = `${field}/${sensitivity}/${asciiSlug(doc.title, doc.id)}`
      const markdown = toMarkdown(doc.title, field, sensitivity, doc.content)
      const corpus = join(dataDir, 'corpus', `${slug}.md`)
      mkdirSync(dirname(corpus), { recursive: true })
      writeFileSync(corpus, markdown, 'utf8')
      try {
        await captureGBrain(config, corpus, slug)
      } catch (err) {
        throw new HttpError(502, err instanceof GBrainError ? err.message : '入库失败')
      }
      db.confirmDoc(doc.id, field, sensitivity, slug, markdown, new Date().toISOString())
      res.json({ ok: true })
    }),
  )

  app.post(
    '/api/admin/docs/:id/reject',
    requireAdmin,
    asyncRoute(async (req, res) => {
      const doc = db.getDoc(req.params.id)
      if (!doc) throw new HttpError(404, '文档不存在')
      db.rejectDoc(doc.id, String(req.body?.reason ?? ''), new Date().toISOString())
      res.json({ ok: true })
    }),
  )

  app.get('/api/admin/health/issues', requireAdmin, (_req, res) => {
    res.json(db.listHealth())
  })

  app.post(
    '/api/admin/health/run',
    requireAdmin,
    asyncRoute(async (_req, res) => {
      try {
        const issues = await runHealth(db, config)
        db.replaceHealth(issues, new Date().toISOString())
      } catch (err) {
        throw new HttpError(502, err instanceof GBrainError ? err.message : '检查失败')
      }
      res.json({ ok: true })
    }),
  )

  app.get('/api/admin/questions', requireAdmin, (req, res) => {
    res.json(
      db.listQuestions({
        field: req.query.field ? String(req.query.field) : undefined,
        status: req.query.status ? String(req.query.status) : undefined,
      }),
    )
  })

  app.get(
    '/api/admin/questions/:id',
    requireAdmin,
    asyncRoute(async (req, res) => {
      const question = db.getQuestion(req.params.id)
      if (!question) throw new HttpError(404, '问题不存在')
      res.json(question)
    }),
  )

  app.post(
    '/api/admin/questions/:id/assign',
    requireAdmin,
    asyncRoute(async (req, res) => {
      const question = db.getQuestion(req.params.id)
      if (!question) throw new HttpError(404, '问题不存在')
      const assignee = db.findUserById(String(req.body?.userId ?? ''))
      if (!assignee) throw new HttpError(400, '负责人不存在')
      db.assignQuestion(question.id, assignee.name)
      res.json({ ok: true })
    }),
  )

  app.post(
    '/api/admin/questions/:id/resolve',
    requireAdmin,
    asyncRoute(async (req, res) => {
      const question = db.getQuestion(req.params.id)
      if (!question) throw new HttpError(404, '问题不存在')
      const title = String(req.body?.title ?? '').trim()
      const answer = String(req.body?.answer ?? '').trim()
      const field = req.body?.field
      const sensitivity = req.body?.sensitivity
      if (!title || !answer) throw new HttpError(400, '请填写知识标题和解答')
      if (!isField(field) || !isSensitivity(sensitivity)) throw new HttpError(400, '领域或密级不正确')
      assertCanConfirm(userOf(res)!, sensitivity)
      db.resolveQuestion(question.id)
      const suggested = guessField(`${title}\n${answer}`, config)
      db.insertDoc({
        id: newId('d'),
        title,
        field,
        sensitivity,
        status: 'pending',
        suggestedField: suggested,
        suggestedSensitivity: guessSensitivity(answer, config),
        content: answer,
        updatedAt: new Date().toISOString(),
      })
      res.json({ ok: true })
    }),
  )

  // 管理员指派问题时也要名单；增改用户仍仅主人
  app.get('/api/admin/users', requireAdmin, (_req, res) => {
    res.json(db.listUsers())
  })

  app.post(
    '/api/admin/users',
    requireOwner,
    asyncRoute(async (req, res) => {
      const name = String(req.body?.name ?? '').trim()
      const password = String(req.body?.password ?? '')
      const role = req.body?.role
      if (!name) throw new HttpError(400, '用户名不能为空')
      if (!password) throw new HttpError(400, '密码不能为空')
      if (!isRole(role) || role === 'guest') throw new HttpError(400, '角色不正确')
      const field = role === 'operator' ? req.body?.field : null
      if (role === 'operator' && !isField(field)) throw new HttpError(400, '操作员必须指定领域')
      if (db.findUserByName(name)) throw new HttpError(400, '用户名已存在')
      const user = { id: newId('u'), name, role: role as Role, field: (field as Field | null) ?? null }
      db.insertUser(user, hashPassword(password))
      res.json(user)
    }),
  )

  app.patch(
    '/api/admin/users/:id',
    requireOwner,
    asyncRoute(async (req, res) => {
      const current = db.findUserById(req.params.id)
      if (!current || current.role === 'guest') throw new HttpError(404, '用户不存在')
      const role = req.body?.role === undefined ? current.role : req.body.role
      if (!isRole(role) || role === 'guest') throw new HttpError(400, '角色不正确')
      const field = role === 'operator' ? (req.body?.field ?? current.field) : null
      if (role === 'operator' && !isField(field)) throw new HttpError(400, '操作员必须指定领域')
      const password = req.body?.password ? String(req.body.password) : ''
      db.updateUser(current.id, {
        role,
        field: field as Field | null,
        passwordHash: password ? hashPassword(password) : undefined,
      })
      res.json(db.findUserById(current.id))
    }),
  )

  app.use('/api', (_req, res) => {
    res.status(404).json({ message: '未实现' })
  })

  // 静态文件：托管前端打包产物（dist/），非 /api 请求返回 index.html（SPA 路由）
  const distDir = join(serverRoot, '..', 'dist')
  app.use(express.static(distDir, { index: false }))
  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api') || req.path.startsWith('/ws')) return next()
    res.sendFile(join(distDir, 'index.html'))
  })

  app.use((err: Error & { status?: number }, _req: Request, res: Response, _next: NextFunction) => {
    const status = err.status ?? 500
    if (status >= 500) console.error(err)
    res.status(status).json({ message: status >= 500 ? '服务器内部错误' : err.message })
  })

  const host = opts?.host ?? process.env.HOST ?? '127.0.0.1'
  const port = opts?.port ?? Number(process.env.PORT ?? 3000)
  const server = createServer(app)
  attachWs(server, db, config)

  await new Promise<void>((resolve) => server.listen(port, host, resolve))
  const address = server.address()
  const actual = typeof address === 'object' && address ? address.port : port
  return {
    port: actual,
    close: () =>
      new Promise((resolve, reject) => {
        server.close((err) => {
          db.close()
          if (err) reject(err)
          else resolve()
        })
      }),
  }
}

function readUploadFile(path: string) {
  return readFileSync(path)
}

function attachWs(server: ReturnType<typeof createServer>, db: KbDb, config: AppConfig) {
  const wss = new WebSocketServer({ noServer: true })
  server.on('upgrade', (req, socket, head) => {
    const url = (req.url ?? '').split('?')[0]
    if (url !== '/ws') {
      socket.destroy()
      return
    }
    const sid = cookieOf(req, config.auth.cookieName)
    const user = sid ? db.authUser(sid) : null
    if (!user) {
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n')
      socket.destroy()
      return
    }
    wss.handleUpgrade(req, socket, head, (ws) => onConnection(ws, user, db, config))
  })
}

function onConnection(ws: WebSocket, user: User, db: KbDb, config: AppConfig) {
  ws.on('message', (raw) => {
    let msg: { type?: string; questionId?: string }
    try {
      msg = JSON.parse(String(raw))
    } catch {
      return
    }
    if (msg.type === 'ping') {
      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ type: 'pong' }))
      return
    }
    if (msg.type === 'cancel' && msg.questionId) {
      cancelAsk(ws, msg.questionId)
      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ type: 'done', questionId: msg.questionId }))
      return
    }
    if (msg.type === 'ask' && msg.questionId) {
      void handleAsk(ws, user, db, config, msg as Parameters<typeof handleAsk>[4])
    }
  })
  ws.on('close', () => cancelAll(ws))
}
