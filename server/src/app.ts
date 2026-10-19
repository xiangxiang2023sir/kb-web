import { createServer, type IncomingMessage } from 'node:http'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import express, { type NextFunction, type Request, type Response } from 'express'
import Busboy from 'busboy'
import { WebSocketServer, type WebSocket } from 'ws'
import { assertCanConfirm, canSee, parseSlug } from './access.js'
import { archiveToPending, listArchives, readArchive, writeWeeklyArchives } from './archive.js'
import { cancelAll, cancelAsk, collectAskResult, contextOf, handleAsk, resolveAgentSession, runAsk } from './ask.js'
import { loadConfig, loadEnvFile, serverRoot, type AppConfig, type Field, type Role, type Sensitivity, type User, isField, isRole, isSensitivity } from './config.js'
import { hashPassword, KbDb, newId, openDb, verifyPassword } from './db.js'
import { GBrainError, captureGBrain, listGBrain, searchGBrain } from './gbrain.js'
import { runHealth } from './health.js'
import { askHermesStream, hermesConfigured, type HermesTurn } from './hermes.js'
import { bearerOf } from './agentTokens.js'
import { buildAgentSkillMarkdown } from './agentSkill.js'
import { classifyText } from './llm.js'
import {
  challengeOf,
  eventPayload,
  feishuConfigured,
  handleFeishuEvent,
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
  /** 外部 agent 限流：bind 每分钟 20 次、search 每分钟 60 次（按 token 名分桶） */
  const rateBuckets = new Map<string, { minute: number; count: number }>()
  function hitRate(key: string, limit: number): boolean {
    const minute = Math.floor(Date.now() / 60000)
    const bucket = rateBuckets.get(key) ?? { minute, count: 0 }
    if (bucket.minute !== minute) {
      bucket.minute = minute
      bucket.count = 0
    }
    bucket.count += 1
    rateBuckets.set(key, bucket)
    return bucket.count > limit
  }
  const dataDir = opts?.dataDir ?? join(serverRoot, 'data')
  mkdirSync(dataDir, { recursive: true })
  const db = openDb(join(dataDir, 'kb.sqlite'))
  db.repairTitles(decodeUploadName)
  for (const doc of db.confirmedDocs()) {
    const parsed = parseSlug(doc.slug)
    if (!parsed) continue
    const markdown = toMarkdown(doc.title, parsed.field, parsed.sensitivity, doc.content, originNameOf(dataDir, doc.sourcePath))
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
  const isStaff = (user: User) => user.role === 'owner' || user.role === 'admin'
  const canViewSession = (user: User, row: { userId: string }) => user.id === row.userId || isStaff(user)
  const sessionJson = (row: ReturnType<KbDb['getChatSessionRow']> & object, user: User) => {
    const r = row as NonNullable<ReturnType<KbDb['getChatSessionRow']>>
    return { ...r, mine: r.userId === user.id, readOnly: r.userId !== user.id }
  }

  app.post(
    '/api/auth/register',
    asyncRoute(async (req, res) => {
      const name = String(req.body?.name ?? '').trim()
      const password = String(req.body?.password ?? '')
      const title = String(req.body?.title ?? '').trim().slice(0, 40)
      const department = String(req.body?.department ?? '').trim().slice(0, 40)
      const note = String(req.body?.note ?? '').trim().slice(0, 200)
      if (name.length < 2 || name.length > 32) throw new HttpError(400, '名字 2~32 个字符')
      if (password.length < 6) throw new HttpError(400, '密码至少 6 位')
      if (!title) throw new HttpError(400, '请填岗位')
      const id = db.createPendingUser({ name, passwordHash: hashPassword(password), title, department, applyNote: note })
      if (!id) throw new HttpError(409, '这个用户名已被占用')
      res.json({ ok: true, status: 'pending', message: '已提交，等管理员批准后即可登录' })
    }),
  )

  app.post(
    '/api/auth/login',
    asyncRoute(async (req, res) => {
      const name = String(req.body?.username ?? '')
      const password = String(req.body?.password ?? '')
      const found = db.findUserByName(name)
      if (!found?.passwordHash || !verifyPassword(password, found.passwordHash)) {
        throw new HttpError(401, '用户名或密码错误')
      }
      if (found.status === 'pending') throw new HttpError(403, '账号还在审核中，等管理员批准后再登录')
      if (found.status === 'rejected') throw new HttpError(403, '这个注册申请已被驳回，请联系管理员')
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

  app.get('/api/chat/sessions', requireUser, (_req, res) => {
    const user = userOf(res)!
    const rows = isStaff(user) ? db.listChatSessions() : db.listChatSessions({ userId: user.id })
    res.json(rows.map((r) => sessionJson(r, user)))
  })

  app.get(
    '/api/chat/sessions/:id/messages',
    requireUser,
    asyncRoute(async (req, res) => {
      const user = userOf(res)!
      const session = db.getChatSessionRow(req.params.id)
      if (!session || !canViewSession(user, session)) throw new HttpError(404, '会话不存在')
      res.json(db.listMessages(req.params.id))
    }),
  )

  app.get(
    '/api/chat/sessions/:id',
    requireUser,
    asyncRoute(async (req, res) => {
      const user = userOf(res)!
      const session = db.getChatSessionRow(req.params.id)
      if (!session || !canViewSession(user, session)) throw new HttpError(404, '会话不存在')
      res.json(sessionJson(session, user))
    }),
  )

  app.delete(
    '/api/chat/sessions/:id',
    requireUser,
    asyncRoute(async (req, res) => {
      const user = userOf(res)!
      const session = db.getChatSessionRow(req.params.id)
      if (!session || !canViewSession(user, session)) throw new HttpError(404, '会话不存在')
      db.deleteChatSession(session.id)
      res.json({ ok: true })
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

  // 把一轮对话（问题/告知 + 回答 + 出处）沉淀成待确认文档；管理员确认领域密级后才真正入库
  app.post(
    '/api/chat/save-to-kb',
    requireUser,
    asyncRoute(async (req, res) => {
      const user = userOf(res)!
      const question = String(req.body?.question ?? '').trim()
      const answer = String(req.body?.answer ?? '').trim()
      const sessionId = typeof req.body?.sessionId === 'string' ? req.body.sessionId : ''
      const rawCitations = Array.isArray(req.body?.citations) ? req.body.citations : []
      if (!question && !answer) throw new HttpError(400, '没有可保存的内容')

      const title = `[对话沉淀] ${(question || answer).replace(/\s+/g, ' ').slice(0, 40)}`
      // 去重：同名待确认文档已存在就不再重复提交
      const existing = db.listDocs({ keyword: title, hideTopSecret: false }).find((d) => d.title === title)
      if (existing) {
        res.json({ ok: true, duplicate: true, id: existing.id })
        return
      }

      const cited = rawCitations
        .map((c: unknown) => (c && typeof (c as { title?: unknown }).title === 'string' ? (c as { title: string }).title : ''))
        .filter(Boolean)
      const body = [
        question ? `## ${question}` : '',
        answer || '（现场告知，无 AI 回答）',
        '',
        '---',
        '',
        `- 来源：对话沉淀（kb-web）`,
        `- 提问人：${user.name}／${user.role}`,
        `- 时间：${new Date().toISOString()}`,
        sessionId ? `- 会话：${sessionId}` : '',
        cited.length ? `- 引用：${cited.join('；')}` : '- 引用：无（现场告知）',
      ]
        .filter((line) => line !== '')
        .join('\n')

      const field = config.defaults.field
      const sensitivity = config.defaults.sensitivity
      const id = newId('d')
      db.insertDoc({
        id,
        title,
        field,
        sensitivity,
        status: 'pending',
        suggestedField: field,
        suggestedSensitivity: sensitivity,
        content: body,
        updatedAt: new Date().toISOString(),
      })
      res.json({ ok: true, id })
    }),
  )

  app.post(
    '/api/chat/save-selected',
    requireUser,
    asyncRoute(async (req, res) => {
      const user = userOf(res)!
      const sessionId = String(req.body?.sessionId ?? '')
      const session = db.getChatSessionRow(sessionId)
      if (!session || !canViewSession(user, session)) throw new HttpError(404, '会话不存在')
      const ids = Array.isArray(req.body?.messageIds) ? req.body.messageIds.map((x: unknown) => String(x)) : []
      if (!ids.length) throw new HttpError(400, '请选择要入库的回答')
      const messages = db.listMessages(sessionId)
      const parts: string[] = []
      for (const id of ids) {
        const answer = messages.find((m) => m.id === id && m.role === 'assistant')
        if (!answer) continue
        const idx = messages.indexOf(answer)
        const question = [...messages.slice(0, idx)].reverse().find((m) => m.role === 'user')
        parts.push(`## ${question?.text || '（无提问）'}\n\n${answer.text}`)
      }
      if (!parts.length) throw new HttpError(400, '没有可保存的内容')
      const title = `[对话摘录] ${session.title}`.slice(0, 80)
      const existing = db.listDocs({ keyword: title, hideTopSecret: false }).find((d) => d.title === title)
      if (existing) {
        res.json({ ok: true, duplicate: true, id: existing.id })
        return
      }
      const content = [
        ...parts,
        '',
        '---',
        '',
        `- 来源：对话摘录（${session.source === 'agent' ? '外部' : '网页'}）`,
        `- 提问人：${session.userName}`,
        `- 提交人：${user.name}／${user.role}`,
        `- 时间：${new Date().toISOString()}`,
        `- 会话：${sessionId}`,
      ].join('\n')
      const id = newId('d')
      db.insertDoc({
        id,
        title,
        field: config.defaults.field,
        sensitivity: config.defaults.sensitivity,
        status: 'pending',
        suggestedField: guessField(content, config),
        suggestedSensitivity: guessSensitivity(content, config),
        content,
        updatedAt: new Date().toISOString(),
      })
      res.json({ ok: true, id })
    }),
  )

  app.get('/api/chat/archives', requireUser, (_req, res) => {
    const user = userOf(res)!
    const rows = listArchives(db, dataDir)
      .filter((r) => isStaff(user) || r.userId === user.id)
      .map((r) => ({ ...r, mine: r.userId === user.id }))
    res.json(rows)
  })

  app.post(
    '/api/chat/archives/run',
    requireAdmin,
    asyncRoute(async (_req, res) => {
      const out = writeWeeklyArchives(db, dataDir, config, { force: true })
      res.json({ ok: true, ...out })
    }),
  )

  app.get(
    '/api/chat/archives/:userId/:weekKey',
    requireUser,
    asyncRoute(async (req, res) => {
      const user = userOf(res)!
      if (!isStaff(user) && req.params.userId !== user.id) throw new HttpError(404, '归档不存在')
      const markdown = readArchive(dataDir, req.params.userId, req.params.weekKey)
      if (!markdown) throw new HttpError(404, '归档不存在')
      res.json({ markdown, title: `对话归档 ${req.params.weekKey}` })
    }),
  )

  app.post(
    '/api/chat/archives/:userId/:weekKey/to-pending',
    requireUser,
    asyncRoute(async (req, res) => {
      const user = userOf(res)!
      if (!isStaff(user) && req.params.userId !== user.id) throw new HttpError(404, '归档不存在')
      try {
        const out = archiveToPending(db, dataDir, config, req.params.userId, req.params.weekKey, user.name)
        res.json({ ok: true, ...out })
      } catch (err) {
        throw new HttpError(404, err instanceof Error ? err.message : '归档不存在')
      }
    }),
  )

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
      const { slug: _s, sourcePath, ...detail } = doc
      res.json({ ...detail, hasOriginal: originalFileOf(dataDir, sourcePath) !== null })
    }),
  )

  // 下载原件：只认 data/inbox 里的文件，路径做前缀校验，防目录穿越
  app.get(
    '/api/admin/docs/:id/original',
    requireAdmin,
    asyncRoute(async (req, res) => {
      const doc = db.getDoc(req.params.id)
      if (!doc) throw new HttpError(404, '文档不存在')
      if (doc.sensitivity === 'top_secret' && userOf(res)!.role !== 'owner') throw new HttpError(403, '无权限')
      const file = originalFileOf(dataDir, doc.sourcePath)
      if (!file) throw new HttpError(404, '这份文档没有留存原件（早期入库或从 GBrain 同步来的）')
      res.setHeader('Content-Type', 'application/octet-stream')
      res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(basename(file))}`)
      res.end(readFileSync(file))
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
      const markdown = toMarkdown(doc.title, field, sensitivity, doc.content, originNameOf(dataDir, doc.sourcePath))
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
  // ---- 删除用户（管理员可删操作员/游客；删管理员或主人需主人；不能删自己；不能删最后一个主人） ----
  app.delete(
    '/api/admin/users/:id',
    requireAdmin,
    asyncRoute(async (req, res) => {
      const me = userOf(res)!
      const id = String(req.params.id)
      const target = db.findUserByIdPlain(id)
      if (!target) throw new HttpError(404, '用户不存在')
      if (target.id === me.id) throw new HttpError(400, '不能删除自己')
      if (target.role === 'owner' || target.role === 'admin') {
        if (me.role !== 'owner') throw new HttpError(403, '只有主人能删除管理员或主人账号')
        if (target.role === 'owner' && db.ownerCount() <= 1) throw new HttpError(400, '至少要保留一个主人账号')
      }
      db.deleteUser(id)
      res.json({ ok: true, deleted: target.name })
    }),
  )

  // ---- 注册审批 ----
  app.get('/api/admin/users/pending', requireAdmin, (_req, res) => {
    res.json(db.pendingUsers())
  })

  app.post(
    '/api/admin/users/:id/approve',
    requireAdmin,
    asyncRoute(async (req, res) => {
      const role = req.body?.role
      if (!isRole(role)) throw new HttpError(400, '角色不正确')
      const fieldRaw = req.body?.field
      const field = fieldRaw == null || fieldRaw === '' ? null : fieldRaw
      if (field !== null && !isField(field)) throw new HttpError(400, '领域不正确')
      // 越权保护：管理员只能批准操作员/游客；批准成管理员或主人只有主人能做
      if ((role === 'owner' || role === 'admin') && userOf(res)!.role !== 'owner') {
        throw new HttpError(403, '只有主人能批准管理员或主人账号')
      }
      const target = db.findUserByIdPlain(String(req.params.id))
      if (!target) throw new HttpError(404, '用户不存在')
      if (target.status !== 'pending') throw new HttpError(400, '只能审批待批准的申请')
      if (target.role === 'owner') throw new HttpError(403, '不能改主人账号')
      db.approveUser(String(req.params.id), role, field)
      res.json({ ok: true })
    }),
  )

  app.post('/api/admin/users/:id/reject', requireAdmin, (req, res) => {
    const target = db.findUserByIdPlain(String(req.params.id))
    if (!target) throw new HttpError(404, '用户不存在')
    if (target.status !== 'pending') throw new HttpError(400, '只能审批待批准的申请')
    if (target.role === 'owner') throw new HttpError(403, '不能改主人账号')
    db.rejectUser(String(req.params.id))
    res.json({ ok: true })
  })

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

  // ---- 找小A：把管理端的对话转给本机 Hermes 网关（小A），流式回传 ----
  app.post(
    '/api/admin/assistant/chat',
    requireAdmin,
    asyncRoute(async (req, res) => {
      const rawTurns = Array.isArray(req.body?.messages) ? req.body.messages : []
      const turns: HermesTurn[] = rawTurns
        .filter(
          (m: unknown): m is { role: 'user' | 'assistant'; content: string } =>
            Boolean(m) &&
            ((m as { role?: string }).role === 'user' || (m as { role?: string }).role === 'assistant') &&
            typeof (m as { content?: unknown }).content === 'string',
        )
        .slice(-20)
        .map((m: { role: 'user' | 'assistant'; content: string }) => ({ role: m.role, content: String(m.content).slice(0, 8000) }))
      if (!turns.length) throw new HttpError(400, '消息不能为空')
      if (!hermesConfigured()) throw new HttpError(503, '未配置 HERMES_API_KEY（server/.env）')

      // 截图：前端先传到 /api/chat/uploads，把返回的 url 或 id 放这里；这里转成 base64 交给小A
      const rawImages = Array.isArray(req.body?.images) ? req.body.images : []
      const dataUrls: string[] = []
      for (const item of rawImages.slice(0, 4)) {
        const raw = String(item ?? '')
        const id = raw.includes('/api/chat/uploads/')
          ? raw.slice(raw.indexOf('/api/chat/uploads/') + '/api/chat/uploads/'.length).split('?')[0]
          : raw
        const row = id ? db.getUpload(id) : undefined
        if (!row) continue
        dataUrls.push(`data:${row.mime};base64,${readUploadFile(row.path).toString('base64')}`)
      }

      const user = userOf(res)!
      if (turns[0].role === 'user') {
        const first = turns[0].content
        turns[0] = {
          role: 'user',
          content: `［来自 kb-web 管理端「AI知识库管理助手」，提问人：${user.name}／${user.role}］\n${
            typeof first === 'string' ? first : ''
          }`,
        }
      }
      if (dataUrls.length) {
        const last = turns[turns.length - 1]
        if (last && last.role === 'user') {
          const text = typeof last.content === 'string' ? last.content : ''
          turns[turns.length - 1] = {
            role: 'user',
            content: [
              { type: 'text', text: text || '（请看这几张截图）' },
              ...dataUrls.map((url) => ({ type: 'image_url' as const, image_url: { url } })),
            ],
          }
        }
      }

      res.setHeader('Content-Type', 'text/event-stream; charset=utf-8')
      res.setHeader('Cache-Control', 'no-cache, no-transform')
      res.setHeader('Connection', 'keep-alive')
      res.flushHeaders()

      const send = (event: string, data: unknown) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
      try {
        const answer = await askHermesStream(turns, { onDelta: (text) => send('delta', { text }) })
        send('done', { text: answer })
      } catch (err) {
        send('error', { message: (err as Error).message })
      } finally {
        res.end()
      }
    }),
  )

  function publicBase(req: Request): string {
    const host = String(req.headers['x-forwarded-host'] ?? req.headers.host ?? '127.0.0.1:3000').split(',')[0].trim()
    const proto = String(req.headers['x-forwarded-proto'] ?? (req.secure ? 'https' : 'http')).split(',')[0].trim()
    return `${proto}://${host}`
  }

  // agent 只认「个人钥匙」（user_agent_keys，网页上自己生成/作废）——全局 AGENT_TOKENS 已停用
  function callerOf(req: Request): { label: string; user: User } | null {
    const token = bearerOf(req.headers.authorization)
    if (!token) return null
    const user = db.userOfAgentKey(token)
    if (user) return { label: user.name, user }
    return null
  }

  // ---- agent 写入接口：个人钥匙，只能写「待确认」，绝不直接进正式库 ----
  // 个人钥匙 = 一人一身份，不需要 channel/external_id 绑定
  function agentUserOf(req: Request): User {
    const caller = callerOf(req)
    if (!caller) throw new HttpError(401, 'token 无效')
    return caller.user
  }
  app.post(
    '/api/agent/capture',
    asyncRoute(async (req, res) => {
      const caller = callerOf(req)
      if (!caller) throw new HttpError(401, 'token 无效')
      const agent = caller.label

      const title = String(req.body?.title ?? '').trim()
      const content = String(req.body?.content ?? '').trim()
      const kind = String(req.body?.kind ?? '经验').trim().slice(0, 12) || '经验'
      if (!title) throw new HttpError(400, 'title 必填')
      if (!content) throw new HttpError(400, 'content 必填')
      if (content.length > 200_000) throw new HttpError(413, '内容过大（上限 200KB）')

      const field: Field = isField(req.body?.field) ? req.body.field : config.defaults.field
      // agent 写入一律不超过 internal：要更高密级，由人在「待确认」里改
      const sensitivity: Sensitivity = 'internal'
      const fullTitle = `[${kind}] ${title}`.slice(0, 120)

      const existed = db
        .listDocs({ keyword: fullTitle, hideTopSecret: false })
        .find((d) => d.title === fullTitle)
      if (existed) {
        res.json({ ok: true, duplicate: true, id: existed.id })
        return
      }

      // 查重提示：先在公共库里找相似页，命中就把"可能重复"写进正文，提醒审阅人并入而不是另开新页
      let similar: { slug: string; title: string }[] = []
      try {
        const hits = await searchGBrain(config, title, 3, 0)
        // 只取公开/内部级：绝密页的标题不能出现在待确认正文里（审阅人可能看不到那份）
        similar = hits
          .filter((h) => !/\/top_secret\//.test(String(h.slug)))
          .map((h) => ({ slug: h.slug, title: String((h as { title?: string }).title ?? h.slug) }))
      } catch {
        similar = []
      }
      const similarNote = similar.length
        ? `\n- 可能重复：${similar.map((s) => `${s.slug}（${s.title}）`).join('；')}\n  ⇒ 请优先并入现有页，别另开新页`
        : ''

      const id = newId('d')
      db.insertDoc({
        id,
        title: fullTitle,
        field,
        sensitivity,
        status: 'pending',
        suggestedField: field,
        suggestedSensitivity: sensitivity,
        content: `${content}\n\n---\n\n- 来源：agent 写入（${agent}）\n- 时间：${new Date().toISOString()}${similarNote}`,
        updatedAt: new Date().toISOString(),
      })
      res.json({ ok: true, id, title: fullTitle, field, sensitivity, status: 'pending' })
    }),
  )

  // Hermes 脚本仍可用绑定码；网页改走「下载 Skill」
  app.post('/api/bind-code', requireUser, (_req, res) => {
    res.json(db.issueBindCode(userOf(res)!.id))
  })

  app.get('/api/bind-code/identities', requireUser, (_req, res) => {
    res.json(db.identitiesOf(userOf(res)!.id))
  })

  app.post('/api/bind-code/unbind', requireUser, (req, res) => {
    db.unbindIdentity(userOf(res)!.id, String(req.body?.channel ?? ''), String(req.body?.externalId ?? ''))
    res.json({ ok: true })
  })

  // ---- 一人一份 Skill：下载即轮换钥匙，旧文件作废 ----
  app.get('/api/agent-skill', requireUser, (_req, res) => {
    const user = userOf(res)!
    if (user.role === 'guest') return res.status(403).json({ message: '游客不能绑定外部 agent' })
    res.json(db.userAgentKeyMeta(user.id) ?? { createdAt: null })
  })

  app.post(
    '/api/agent-skill',
    requireUser,
    asyncRoute(async (req, res) => {
      const user = userOf(res)!
      if (user.role === 'guest') throw new HttpError(403, '游客不能绑定外部 agent')
      if (hitRate(`skill:${user.id}`, 5)) throw new HttpError(429, '下载过于频繁')
      const issued = db.issueUserAgentKey(user.id)
      const markdown = buildAgentSkillMarkdown({
        base: publicBase(req),
        token: issued.token,
        userName: user.name,
      })
      res.json({ filename: 'kb-web.SKILL.md', markdown, createdAt: issued.createdAt })
    }),
  )

  app.delete('/api/agent-skill', requireUser, (_req, res) => {
    const user = userOf(res)!
    if (user.role === 'guest') return res.status(403).json({ message: '游客不能绑定外部 agent' })
    db.revokeUserAgentKey(user.id)
    res.json({ ok: true })
  })

  // ---- 外部 agent：走网页同一套问答，返回完整答案供原样转发 ----
  app.post(
    '/api/agent/ask',
    asyncRoute(async (req, res) => {
      const caller = callerOf(req)
      if (!caller) throw new HttpError(401, 'token 无效')
      if (hitRate(`ask:${caller.user?.id ?? caller.label}`, 30)) throw new HttpError(429, '请求过于频繁（每分钟 30 次）')
      const query = String(req.body?.query ?? '').trim()
      if (!query) throw new HttpError(400, 'query 必填')
      const user = agentUserOf(req)
      const sessionId = resolveAgentSession(db, user, config, req.body ?? {})
      const collected = collectAskResult()
      await runAsk(
        user,
        db,
        config,
        { type: 'ask', questionId: newId('q'), question: query, sessionId },
        collected.emit,
        undefined,
        { publicOnly: true, source: 'agent' },
      )
      const out = collected.result()
      if (out.error && !out.answer) throw new HttpError(502, out.error)
      res.json({
        ok: true,
        user: user.name,
        sessionId: out.sessionId || sessionId,
        answer: out.answer,
        phase: out.phase,
        citations: out.citations,
      })
    }),
  )

  // ---- 外部 agent：只读检索（Hermes 等仍可拿片段；车间 Skill 走 /ask） ----
  app.post(
    '/api/agent/search',
    asyncRoute(async (req, res) => {
      const caller = callerOf(req)
      if (!caller) throw new HttpError(401, 'token 无效')
      if (hitRate(`search:${caller.user?.id ?? caller.label}`, 60)) throw new HttpError(429, '请求过于频繁（每分钟 60 次）')

      const query = String(req.body?.query ?? '').trim()
      if (!query) throw new HttpError(400, 'query 必填')
      const user = agentUserOf(req)

      const limit = Math.min(Math.max(Number(req.body?.limit ?? 5), 1), 5)
      const rows = await searchGBrain(config, query, Math.max(limit * 3, 10), 0).catch(() => [])
      const hits: Record<string, unknown>[] = []
      for (const row of rows) {
        const parsed = parseSlug(row.slug)
        if (!parsed || !canSee(user, parsed.field, parsed.sensitivity)) continue
        if (parsed.sensitivity === 'confidential' || parsed.sensitivity === 'top_secret') continue
        hits.push({
          slug: row.slug,
          title: String((row as { title?: string }).title ?? row.slug),
          marker: `[${hits.length + 1}]`,
          field: parsed.field,
          sensitivity: parsed.sensitivity,
          snippet: String((row as { chunkText?: string }).chunkText ?? '').slice(0, 800),
        })
        if (hits.length >= limit) break
      }
      res.json({ ok: true, user: user.name, hits, noEvidence: hits.length ? null : config.noEvidence.text })
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

  const runArchive = () => {
    try {
      writeWeeklyArchives(db, dataDir, config)
    } catch (err) {
      console.error('[archive]', err)
    }
  }
  runArchive()
  const archiveTimer = setInterval(runArchive, 3600_000)

  await new Promise<void>((resolve) => server.listen(port, host, resolve))
  const address = server.address()
  const actual = typeof address === 'object' && address ? address.port : port
  return {
    port: actual,
    close: () =>
      new Promise((resolve, reject) => {
        clearInterval(archiveTimer)
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

/** 原件是否还在（必须落在 dataDir 里且是文件），返回绝对路径或 null */
function originalFileOf(dataDir: string, sourcePath: string | null | undefined): string | null {
  if (!sourcePath) return null
  const abs = sourcePath
  if (!abs.startsWith(dataDir)) return null
  return existsSync(abs) ? abs : null
}

/** 页面里登记用的原件文件名（没有就返回 undefined） */
function originNameOf(dataDir: string, sourcePath: string | null | undefined): string | undefined {
  const file = originalFileOf(dataDir, sourcePath)
  return file ? basename(file) : undefined
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
