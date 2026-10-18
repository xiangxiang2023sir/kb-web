import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import type { Field, Role, Sensitivity, User } from './config.js'

export function hashPassword(password: string): string {
  const salt = randomBytes(16).toString('hex')
  const hash = scryptSync(password, salt, 32).toString('hex')
  return `${salt}:${hash}`
}

export function verifyPassword(password: string, stored: string): boolean {
  const [salt, hash] = stored.split(':')
  if (!salt || !hash) return false
  const got = scryptSync(password, salt, 32)
  const expect = Buffer.from(hash, 'hex')
  return got.length === expect.length && timingSafeEqual(got, expect)
}

export function newId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${randomBytes(3).toString('hex')}`
}

type Row = Record<string, unknown>

function userOf(row: Row | undefined): User | null {
  if (!row) return null
  return {
    id: String(row.id),
    name: String(row.name),
    role: row.role as Role,
    field: (row.field as Field | null) ?? null,
  }
}

export class KbDb {
  constructor(readonly db: DatabaseSync) {}

  exec(sql: string) {
    this.db.exec(sql)
  }

  private one(sql: string, ...args: unknown[]): Row | undefined {
    return this.db.prepare(sql).get(...(args as [])) as Row | undefined
  }

  private many(sql: string, ...args: unknown[]): Row[] {
    return this.db.prepare(sql).all(...(args as [])) as Row[]
  }

  private run(sql: string, ...args: unknown[]) {
    this.db.prepare(sql).run(...(args as []))
  }

  authUser(sessionId: string): User | null {
    const row = this.one(
      `SELECT u.id, u.name, u.role, u.field FROM auth_sessions s
       JOIN users u ON u.id = s.user_id
       WHERE s.id = ? AND s.expires_at > ?`,
      sessionId,
      new Date().toISOString(),
    )
    return userOf(row)
  }

  createAuthSession(userId: string, ttlDays: number): string {
    const id = newId('sid')
    const expires = new Date(Date.now() + ttlDays * 86400_000).toISOString()
    this.run(`INSERT INTO auth_sessions (id, user_id, expires_at) VALUES (?, ?, ?)`, id, userId, expires)
    return id
  }

  deleteAuthSession(id: string) {
    this.run(`DELETE FROM auth_sessions WHERE id = ?`, id)
  }

  findUserByName(name: string): (User & { passwordHash: string | null }) | null {
    const row = this.one(`SELECT id, name, role, field, password_hash FROM users WHERE name = ?`, name)
    const user = userOf(row)
    if (!user || !row) return null
    return { ...user, passwordHash: row.password_hash == null ? null : String(row.password_hash) }
  }

  findUserById(id: string): User | null {
    return userOf(this.one(`SELECT id, name, role, field FROM users WHERE id = ?`, id))
  }

  listUsers(): User[] {
    return this.many(`SELECT id, name, role, field FROM users WHERE role != 'guest' ORDER BY name`).map(
      (r) => userOf(r)!,
    )
  }

  insertUser(user: User, passwordHash: string) {
    this.run(
      `INSERT INTO users (id, name, password_hash, role, field) VALUES (?, ?, ?, ?, ?)`,
      user.id,
      user.name,
      passwordHash,
      user.role,
      user.field,
    )
  }

  updateUser(id: string, patch: { role?: Role; field?: Field | null; passwordHash?: string }) {
    if (patch.role) this.run(`UPDATE users SET role = ? WHERE id = ?`, patch.role, id)
    if ('field' in patch) this.run(`UPDATE users SET field = ? WHERE id = ?`, patch.field ?? null, id)
    if (patch.passwordHash) this.run(`UPDATE users SET password_hash = ? WHERE id = ?`, patch.passwordHash, id)
  }

  listChatSessions(userId: string) {
    return this.many(
      `SELECT id, title, updated_at, preview FROM chat_sessions WHERE user_id = ? ORDER BY updated_at DESC`,
      userId,
    ).map((r) => ({
      id: String(r.id),
      title: String(r.title),
      updatedAt: String(r.updated_at),
      preview: r.preview == null ? undefined : String(r.preview),
    }))
  }

  getChatSession(id: string, userId: string) {
    return this.one(`SELECT id FROM chat_sessions WHERE id = ? AND user_id = ?`, id, userId)
  }

  insertChatSession(row: { id: string; userId: string; title: string; preview: string; updatedAt: string }) {
    this.run(
      `INSERT INTO chat_sessions (id, user_id, title, preview, updated_at) VALUES (?, ?, ?, ?, ?)`,
      row.id,
      row.userId,
      row.title,
      row.preview,
      row.updatedAt,
    )
  }

  touchChatSession(id: string, preview: string, updatedAt: string) {
    this.run(`UPDATE chat_sessions SET preview = ?, updated_at = ? WHERE id = ?`, preview, updatedAt, id)
  }

  listMessages(sessionId: string) {
    return this.many(
      `SELECT id, role, text, citations_json, attachments_json, confidence_json, created_at
       FROM chat_messages WHERE session_id = ? ORDER BY created_at`,
      sessionId,
    ).map((r) => ({
      id: String(r.id),
      role: r.role as 'user' | 'assistant',
      text: String(r.text),
      citations: JSON.parse(String(r.citations_json || '[]')),
      attachments: r.attachments_json ? JSON.parse(String(r.attachments_json)) : undefined,
      confidence: r.confidence_json ? JSON.parse(String(r.confidence_json)) : undefined,
      createdAt: String(r.created_at),
    }))
  }

  insertMessage(row: {
    id: string
    sessionId: string
    role: 'user' | 'assistant'
    text: string
    citations?: unknown
    attachments?: unknown
    confidence?: unknown
    createdAt: string
  }) {
    this.run(
      `INSERT INTO chat_messages
        (id, session_id, role, text, citations_json, attachments_json, confidence_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      row.id,
      row.sessionId,
      row.role,
      row.text,
      JSON.stringify(row.citations ?? []),
      row.attachments ? JSON.stringify(row.attachments) : null,
      row.confidence ? JSON.stringify(row.confidence) : null,
      row.createdAt,
    )
  }

  recentMessages(sessionId: string, limit: number) {
    const rows = this.listMessages(sessionId)
    return rows.slice(-limit)
  }

  insertUpload(row: { id: string; userId: string; name: string; mime: string; size: number; path: string; createdAt: string }) {
    this.run(
      `INSERT INTO uploads (id, user_id, name, mime, size, path, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      row.id,
      row.userId,
      row.name,
      row.mime,
      row.size,
      row.path,
      row.createdAt,
    )
  }

  getUpload(id: string) {
    const r = this.one(`SELECT id, user_id, name, mime, size, path FROM uploads WHERE id = ?`, id)
    if (!r) return null
    return {
      id: String(r.id),
      userId: String(r.user_id),
      name: String(r.name),
      mime: String(r.mime),
      size: Number(r.size),
      path: String(r.path),
    }
  }

  repairTitles(fix: (title: string) => string): string[] {
    const changed: string[] = []
    for (const r of this.many(`SELECT id, title FROM docs`)) {
      const next = fix(String(r.title))
      if (next === r.title) continue
      this.run(`UPDATE docs SET title = ? WHERE id = ?`, next, r.id)
      changed.push(String(r.id))
    }
    return changed
  }

  insertDoc(row: {
    id: string
    title: string
    field: Field
    sensitivity: Sensitivity
    status: string
    suggestedField: Field
    suggestedSensitivity: Sensitivity
    content: string
    updatedAt: string
    sourcePath?: string
  }) {
    this.run(
      `INSERT INTO docs
        (id, title, field, sensitivity, status, suggested_field, suggested_sensitivity, content, updated_at, source_path)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      row.id,
      row.title,
      row.field,
      row.sensitivity,
      row.status,
      row.suggestedField,
      row.suggestedSensitivity,
      row.content,
      row.updatedAt,
      row.sourcePath ?? null,
    )
  }

  listDocs(filter: { keyword?: string; field?: string; sensitivity?: string; status?: string; hideTopSecret: boolean }) {
    const where: string[] = []
    const args: unknown[] = []
    if (filter.keyword) {
      where.push(`title LIKE ?`)
      args.push(`%${filter.keyword}%`)
    }
    if (filter.field) {
      where.push(`field = ?`)
      args.push(filter.field)
    }
    if (filter.sensitivity) {
      where.push(`sensitivity = ?`)
      args.push(filter.sensitivity)
    }
    if (filter.status) {
      where.push(`status = ?`)
      args.push(filter.status)
    }
    if (filter.hideTopSecret) where.push(`sensitivity != 'top_secret'`)
    const sql = `SELECT id, title, field, sensitivity, status, suggested_field, suggested_sensitivity, updated_at, slug
      FROM docs ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY updated_at DESC`
    return this.many(sql, ...args).map(docItem)
  }

  getDoc(id: string) {
    const r = this.one(`SELECT * FROM docs WHERE id = ?`, id)
    if (!r) return null
    return {
      ...docItem(r),
      content: String(r.content ?? ''),
      slug: r.slug == null ? null : String(r.slug),
      sourcePath: r.source_path == null ? null : String(r.source_path),
      referencedBy: this.many(
        `SELECT session_id, question, asked_at FROM doc_refs WHERE doc_id = ? ORDER BY asked_at DESC`,
        id,
      ).map((x) => ({ sessionId: String(x.session_id), question: String(x.question), askedAt: String(x.asked_at) })),
    }
  }

  confirmDoc(id: string, field: Field, sensitivity: Sensitivity, slug: string, content: string, updatedAt: string) {
    this.run(
      `UPDATE docs SET status = 'confirmed', field = ?, sensitivity = ?, slug = ?, content = ?, updated_at = ? WHERE id = ?`,
      field,
      sensitivity,
      slug,
      content,
      updatedAt,
      id,
    )
  }

  rejectDoc(id: string, reason: string, updatedAt: string) {
    this.run(
      `UPDATE docs SET status = 'rejected', reject_reason = ?, updated_at = ? WHERE id = ?`,
      reason,
      updatedAt,
      id,
    )
  }

  findDocBySlug(slug: string) {
    const r = this.one(`SELECT id, title, slug FROM docs WHERE slug = ? AND status = 'confirmed'`, slug)
    if (!r) return null
    return { id: String(r.id), title: String(r.title), slug: String(r.slug) }
  }

  confirmedSlugs(): Set<string> {
    return new Set(this.many(`SELECT slug FROM docs WHERE status = 'confirmed' AND slug IS NOT NULL`).map((r) => String(r.slug)))
  }

  confirmedDocs(): { id: string; title: string; slug: string; content: string }[] {
    return this.many(`SELECT id, title, slug, content FROM docs WHERE status = 'confirmed' AND slug IS NOT NULL`).map((r) => ({
      id: String(r.id),
      title: String(r.title),
      slug: String(r.slug),
      content: String(r.content ?? ''),
    }))
  }

  addDocRef(docId: string, sessionId: string, question: string, askedAt: string) {
    this.run(
      `INSERT INTO doc_refs (id, doc_id, session_id, question, asked_at) VALUES (?, ?, ?, ?, ?)`,
      newId('ref'),
      docId,
      sessionId,
      question,
      askedAt,
    )
  }

  insertQuestion(row: {
    id: string
    question: string
    askedBy: string
    askedById: string
    field: Field
    status: string
    sessionId?: string
    context?: string
    createdAt: string
  }) {
    this.run(
      `INSERT INTO questions (id, question, asked_by, asked_by_id, field, status, session_id, context, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      row.id,
      row.question,
      row.askedBy,
      row.askedById,
      row.field,
      row.status,
      row.sessionId ?? null,
      row.context ?? null,
      row.createdAt,
    )
  }

  listQuestions(filter: { field?: string; status?: string; askedById?: string }) {
    const where: string[] = []
    const args: unknown[] = []
    if (filter.field) {
      where.push(`field = ?`)
      args.push(filter.field)
    }
    if (filter.status) {
      where.push(`status = ?`)
      args.push(filter.status)
    }
    if (filter.askedById) {
      where.push(`asked_by_id = ?`)
      args.push(filter.askedById)
    }
    const sql = `SELECT * FROM questions ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY created_at DESC`
    return this.many(sql, ...args).map(questionItem)
  }

  getQuestion(id: string) {
    const r = this.one(`SELECT * FROM questions WHERE id = ?`, id)
    if (!r) return null
    return {
      ...questionItem(r),
      sessionId: r.session_id == null ? undefined : String(r.session_id),
      context: r.context == null ? undefined : String(r.context),
    }
  }

  assignQuestion(id: string, assignee: string) {
    this.run(`UPDATE questions SET assignee = ?, status = 'assigned' WHERE id = ?`, assignee, id)
  }

  resolveQuestion(id: string) {
    this.run(`UPDATE questions SET status = 'resolved' WHERE id = ?`, id)
  }

  replaceHealth(issues: { id: string; type: string; docId: string; docTitle: string; detail: string }[], ranAt: string) {
    this.exec(`DELETE FROM health_issues`)
    for (const issue of issues) {
      this.run(
        `INSERT INTO health_issues (id, type, doc_id, doc_title, detail, ran_at) VALUES (?, ?, ?, ?, ?, ?)`,
        issue.id,
        issue.type,
        issue.docId,
        issue.docTitle,
        issue.detail,
        ranAt,
      )
    }
  }

  listHealth() {
    return this.many(`SELECT id, type, doc_id, doc_title, detail FROM health_issues ORDER BY type, doc_title`).map((r) => ({
      id: String(r.id),
      type: String(r.type),
      docId: String(r.doc_id),
      docTitle: String(r.doc_title),
      detail: String(r.detail),
    }))
  }

  createFeishuBindCode(code: string, userId: string, ttlSec: number) {
    this.run(`DELETE FROM feishu_bind_codes WHERE user_id = ?`, userId)
    const expires = new Date(Date.now() + ttlSec * 1000).toISOString()
    this.run(`INSERT INTO feishu_bind_codes (code, user_id, expires_at) VALUES (?, ?, ?)`, code, userId, expires)
  }

  consumeFeishuBindCode(code: string): string | null {
    const row = this.one(`SELECT user_id, expires_at FROM feishu_bind_codes WHERE code = ?`, code.toUpperCase())
    this.run(`DELETE FROM feishu_bind_codes WHERE code = ?`, code.toUpperCase())
    if (!row) return null
    if (String(row.expires_at) < new Date().toISOString()) return null
    return String(row.user_id)
  }

  bindFeishu(openId: string, userId: string) {
    this.run(`DELETE FROM feishu_bindings WHERE open_id = ? OR user_id = ?`, openId, userId)
    this.run(
      `INSERT INTO feishu_bindings (open_id, user_id, bound_at) VALUES (?, ?, ?)`,
      openId,
      userId,
      new Date().toISOString(),
    )
  }

  unbindFeishu(openId: string) {
    this.run(`DELETE FROM feishu_bindings WHERE open_id = ?`, openId)
  }

  getFeishuBinding(openId: string): { userId: string; sessionId?: string } | null {
    const row = this.one(`SELECT user_id, session_id FROM feishu_bindings WHERE open_id = ?`, openId)
    if (!row) return null
    return { userId: String(row.user_id), sessionId: row.session_id ? String(row.session_id) : undefined }
  }

  setFeishuSession(openId: string, sessionId: string) {
    this.run(`UPDATE feishu_bindings SET session_id = ? WHERE open_id = ?`, sessionId, openId)
  }

  listFeishuBindings(): { openId: string; userId: string; userName: string; boundAt: string }[] {
    return this.many(
      `SELECT b.open_id, b.user_id, b.bound_at, u.name AS user_name
       FROM feishu_bindings b JOIN users u ON u.id = b.user_id
       ORDER BY b.bound_at DESC`,
    ).map((r) => ({
      openId: String(r.open_id),
      userId: String(r.user_id),
      userName: String(r.user_name),
      boundAt: String(r.bound_at),
    }))
  }

  seenFeishuEvent(eventId: string): boolean {
    const row = this.one(`SELECT id FROM feishu_events WHERE id = ?`, eventId)
    if (row) return true
    this.run(`INSERT INTO feishu_events (id, seen_at) VALUES (?, ?)`, eventId, new Date().toISOString())
    this.run(`DELETE FROM feishu_events WHERE seen_at < ?`, new Date(Date.now() - 24 * 3600_000).toISOString())
    return false
  }

  overview() {
    const start = new Date()
    start.setHours(0, 0, 0, 0)
    const today = this.one(
      `SELECT COUNT(*) AS n FROM chat_messages WHERE role = 'user' AND created_at >= ?`,
      start.toISOString(),
    )
    return {
      pendingDocs: count(this, `SELECT COUNT(*) AS n FROM docs WHERE status = 'pending'`),
      unassignedQuestions: count(this, `SELECT COUNT(*) AS n FROM questions WHERE status = 'open'`),
      failedChecks: count(this, `SELECT COUNT(*) AS n FROM health_issues`),
      todayQuestions: Number(today?.n ?? 0),
    }
  }

  close() {
    this.db.close()
  }
}

function count(db: KbDb, sql: string): number {
  const row = db.db.prepare(sql).get() as { n?: number } | undefined
  return Number(row?.n ?? 0)
}

function docItem(r: Row) {
  return {
    id: String(r.id),
    title: String(r.title),
    field: r.field as Field,
    sensitivity: r.sensitivity as Sensitivity,
    status: String(r.status) as 'pending' | 'confirmed' | 'rejected',
    updatedAt: String(r.updated_at),
    suggestedField: r.suggested_field == null ? undefined : (r.suggested_field as Field),
    suggestedSensitivity: r.suggested_sensitivity == null ? undefined : (r.suggested_sensitivity as Sensitivity),
    slug: r.slug == null ? undefined : String(r.slug),
  }
}

function questionItem(r: Row) {
  return {
    id: String(r.id),
    question: String(r.question),
    askedBy: String(r.asked_by),
    field: r.field as Field,
    status: String(r.status) as 'open' | 'assigned' | 'resolved',
    assignee: r.assignee == null ? undefined : String(r.assignee),
    createdAt: String(r.created_at),
  }
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  name TEXT UNIQUE NOT NULL,
  password_hash TEXT,
  role TEXT NOT NULL,
  field TEXT
);
CREATE TABLE IF NOT EXISTS auth_sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS chat_sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  title TEXT NOT NULL,
  preview TEXT,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS chat_messages (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  role TEXT NOT NULL,
  text TEXT NOT NULL,
  citations_json TEXT NOT NULL DEFAULT '[]',
  attachments_json TEXT,
  confidence_json TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS uploads (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  name TEXT NOT NULL,
  mime TEXT NOT NULL,
  size INTEGER NOT NULL,
  path TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS docs (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  field TEXT NOT NULL,
  sensitivity TEXT NOT NULL,
  status TEXT NOT NULL,
  suggested_field TEXT,
  suggested_sensitivity TEXT,
  content TEXT NOT NULL DEFAULT '',
  slug TEXT,
  reject_reason TEXT,
  source_path TEXT,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS doc_refs (
  id TEXT PRIMARY KEY,
  doc_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  question TEXT NOT NULL,
  asked_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS questions (
  id TEXT PRIMARY KEY,
  question TEXT NOT NULL,
  asked_by TEXT NOT NULL,
  asked_by_id TEXT NOT NULL,
  field TEXT NOT NULL,
  status TEXT NOT NULL,
  assignee TEXT,
  session_id TEXT,
  context TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS health_issues (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  doc_id TEXT NOT NULL,
  doc_title TEXT NOT NULL,
  detail TEXT NOT NULL,
  ran_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS feishu_bindings (
  open_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  session_id TEXT,
  bound_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS feishu_bind_codes (
  code TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS feishu_events (
  id TEXT PRIMARY KEY,
  seen_at TEXT NOT NULL
);
`

export function openDb(path: string): KbDb {
  mkdirSync(dirname(path), { recursive: true })
  const db = new DatabaseSync(path)
  db.exec(`PRAGMA journal_mode = WAL`)
  db.exec(SCHEMA)
  const store = new KbDb(db)
  const n = store['one'](`SELECT COUNT(*) AS n FROM users`)
  if (Number(n?.n ?? 0) === 0) seed(store)
  return store
}

function seed(db: KbDb) {
  const rows: { id: string; name: string; password: string; role: Role; field: Field | null }[] = [
    { id: 'u1', name: 'owner', password: 'admin123', role: 'owner', field: null },
    { id: 'u2', name: 'admin', password: 'admin123', role: 'admin', field: null },
    { id: 'u3', name: 'wang', password: '123456', role: 'operator', field: 'electrical' },
    { id: 'u4', name: 'li', password: '123456', role: 'operator', field: 'mechanical' },
    { id: 'u5', name: 'zhao', password: '123456', role: 'operator', field: 'dispatch' },
  ]
  for (const row of rows) {
    db.insertUser({ id: row.id, name: row.name, role: row.role, field: row.field }, hashPassword(row.password))
  }
  db.insertUser({ id: 'guest', name: '游客', role: 'guest', field: null }, '')
}
