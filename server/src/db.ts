import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import type { Field, Role, Sensitivity, User } from './config.js'

function hashUserAgentKey(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

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

  findUserByName(
    name: string,
  ): (User & { passwordHash: string | null; status: string; title: string | null; department: string | null }) | null {
    const row = this.one(
      `SELECT id, name, employee_no, role, field, password_hash, status, title, department FROM users WHERE name = ?`,
      name,
    )
    const user = userOf(row)
    if (!user || !row) return null
    return {
      ...user,
      passwordHash: row.password_hash == null ? null : String(row.password_hash),
      status: row.status == null ? 'approved' : String(row.status),
      title: row.title == null ? null : String(row.title),
      department: row.department == null ? null : String(row.department),
    }
  }

  /** 登录：只认工号（姓名仅作显示，不参与登录） */
  findUserByLogin(
    login: string,
  ): (User & { passwordHash: string | null; status: string; title: string | null; department: string | null; employeeNo: string | null }) | null {
    const row = this.one(
      `SELECT id, name, employee_no, role, field, password_hash, status, title, department FROM users WHERE employee_no = ? LIMIT 1`,
      login,
    )
    const user = userOf(row)
    if (!user || !row) return null
    return {
      ...user,
      passwordHash: row.password_hash == null ? null : String(row.password_hash),
      status: row.status == null ? 'approved' : String(row.status),
      title: row.title == null ? null : String(row.title),
      department: row.department == null ? null : String(row.department),
      employeeNo: row.employee_no == null ? null : String(row.employee_no),
    }
  }

  findUserById(id: string): User | null {
    return userOf(this.one(`SELECT id, name, employee_no, role, field FROM users WHERE id = ?`, id))
  }

  /** 改工号（登录名） */
  setEmployeeNo(userId: string, employeeNo: string) {
    this.run(`UPDATE users SET employee_no = ? WHERE id = ?`, employeeNo, userId)
  }

  listUsers(): User[] {
    return this.many(`SELECT id, name, employee_no, role, field FROM users WHERE role != 'guest' ORDER BY name`).map(
      (r) => userOf(r)!,
    )
  }

  insertUser(user: User & { employeeNo?: string | null }, passwordHash: string) {
    this.run(
      `INSERT INTO users (id, name, employee_no, password_hash, role, field) VALUES (?, ?, ?, ?, ?, ?)`,
      user.id,
      user.name,
      user.employeeNo ?? user.name,
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

  private sessionOf(r: Row) {
    return {
      id: String(r.id),
      userId: String(r.user_id),
      userName: String(r.user_name ?? ''),
      title: String(r.title),
      updatedAt: String(r.updated_at),
      preview: r.preview == null ? undefined : String(r.preview),
      source: r.source === 'agent' ? ('agent' as const) : ('web' as const),
    }
  }

  listChatSessions(opts?: { userId?: string }) {
    const sql = `SELECT s.id, s.user_id, s.title, s.preview, s.updated_at, s.source, u.name AS user_name
       FROM chat_sessions s JOIN users u ON u.id = s.user_id
       ${opts?.userId ? 'WHERE s.user_id = ?' : ''}
       ORDER BY s.updated_at DESC`
    const rows = opts?.userId ? this.many(sql, opts.userId) : this.many(sql)
    return rows.map((r) => this.sessionOf(r))
  }

  getChatSession(id: string, userId: string) {
    return this.one(`SELECT id FROM chat_sessions WHERE id = ? AND user_id = ?`, id, userId)
  }

  getChatSessionRow(id: string) {
    const r = this.one(
      `SELECT s.id, s.user_id, s.title, s.preview, s.updated_at, s.source, u.name AS user_name
       FROM chat_sessions s JOIN users u ON u.id = s.user_id WHERE s.id = ?`,
      id,
    )
    return r ? this.sessionOf(r) : null
  }

  insertChatSession(row: {
    id: string
    userId: string
    title: string
    preview: string
    updatedAt: string
    source?: 'web' | 'agent'
  }) {
    this.run(
      `INSERT INTO chat_sessions (id, user_id, title, preview, updated_at, source) VALUES (?, ?, ?, ?, ?, ?)`,
      row.id,
      row.userId,
      row.title,
      row.preview,
      row.updatedAt,
      row.source === 'agent' ? 'agent' : 'web',
    )
  }

  latestAgentSession(userId: string) {
    const r = this.one(
      `SELECT id, updated_at FROM chat_sessions WHERE user_id = ? AND source = 'agent' ORDER BY updated_at DESC LIMIT 1`,
      userId,
    )
    if (!r) return null
    return { id: String(r.id), updatedAt: String(r.updated_at) }
  }

  countMessages(sessionId: string): number {
    return Number(this.one(`SELECT COUNT(*) AS n FROM chat_messages WHERE session_id = ?`, sessionId)?.n ?? 0)
  }

  deleteChatSession(id: string) {
    this.run(`DELETE FROM chat_messages WHERE session_id = ?`, id)
    this.run(`DELETE FROM doc_refs WHERE session_id = ?`, id)
    this.run(`DELETE FROM chat_sessions WHERE id = ?`, id)
  }

  pruneExtraSessions(userId: string, max: number) {
    const keep = Math.max(1, max)
    const ids = this.many(
      `SELECT id FROM chat_sessions WHERE user_id = ? ORDER BY updated_at DESC`,
      userId,
    ).map((r) => String(r.id))
    for (const id of ids.slice(keep)) this.deleteChatSession(id)
  }

  sessionsWithMessagesBetween(startIso: string, endIso: string) {
    return this.many(
      `SELECT DISTINCT s.id, s.user_id, s.title, s.preview, s.updated_at, s.source, u.name AS user_name
       FROM chat_messages m
       JOIN chat_sessions s ON s.id = m.session_id
       JOIN users u ON u.id = s.user_id
       WHERE m.created_at >= ? AND m.created_at < ?
       ORDER BY s.user_id, s.updated_at`,
      startIso,
      endIso,
    ).map((r) => this.sessionOf(r))
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
    projectId?: string | null
    submittedBy?: string | null
    submittedVia?: string | null
    submitterAgent?: string | null
  }) {
    this.run(
      `INSERT INTO docs
        (id, title, field, sensitivity, status, suggested_field, suggested_sensitivity, content, updated_at, source_path, project_id, submitted_by, submitted_via, submitter_agent)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
      row.projectId ?? null,
      row.submittedBy ?? null,
      row.submittedVia ?? null,
      row.submitterAgent ?? null,
    )
  }

  listDocs(filter: { keyword?: string; field?: string; sensitivity?: string; status?: string; hideTopSecret: boolean; project?: string; submittedBy?: string; via?: string }) {
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
    if (filter.project) {
      where.push(`project_id = ?`)
      args.push(filter.project)
    }
    if (filter.submittedBy) {
      where.push(`submitted_by = ?`)
      args.push(filter.submittedBy)
    }
    if (filter.via) {
      where.push(`submitted_via = ?`)
      args.push(filter.via)
    }
    if (filter.status) {
      where.push(`status = ?`)
      args.push(filter.status)
    }
    if (filter.hideTopSecret) where.push(`sensitivity != 'top_secret'`)
    const sql = `SELECT id, title, field, sensitivity, status, suggested_field, suggested_sensitivity, updated_at, slug, reject_reason, project_id, submitted_by, submitted_via, submitter_agent
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

  // ---- 通用「外部 agent 身份」绑定（飞书/Teams/豆包…都走这套） ----

  /** 生成一次性绑定码（替换原来只能绑飞书的码） */
  issueBindCode(userId: string): { code: string; expiresIn: number } {
    const code = randomBytes(3).toString('hex').toUpperCase()
    const ttl = 3600
    const expires = new Date(Date.now() + ttl * 1000).toISOString()
    this.run(`DELETE FROM bind_codes WHERE user_id = ?`, userId)
    this.run(`INSERT INTO bind_codes (code, user_id, expires_at) VALUES (?, ?, ?)`, code, userId, expires)
    return { code, expiresIn: ttl }
  }

  /** 用码换 userId（一次性，过期作废） */
  consumeBindCode(code: string): string | null {
    const key = String(code || '').trim().toUpperCase()
    if (!key) return null
    const row = this.one(`SELECT user_id, expires_at FROM bind_codes WHERE code = ?`, key)
    this.run(`DELETE FROM bind_codes WHERE code = ?`, key)
    if (!row) return null
    if (String(row.expires_at) < new Date().toISOString()) return null
    return String(row.user_id)
  }

  bindIdentity(channel: string, externalId: string, userId: string) {
    this.run(`DELETE FROM agent_identities WHERE channel = ? AND external_id = ?`, channel, externalId)
    this.run(`DELETE FROM agent_identities WHERE channel = ? AND user_id = ?`, channel, userId)
    this.run(
      `INSERT INTO agent_identities (channel, external_id, user_id, bound_at) VALUES (?, ?, ?, ?)`,
      channel,
      externalId,
      userId,
      new Date().toISOString(),
    )
  }

  userOfIdentity(channel: string, externalId: string): User | null {
    const row = this.one(
      `SELECT u.id, u.name, u.role, u.field FROM agent_identities i JOIN users u ON u.id = i.user_id
       WHERE i.channel = ? AND i.external_id = ?`,
      channel,
      externalId,
    )
    if (!row) return null
    return { id: String(row.id), name: String(row.name), role: row.role as Role, field: (row.field ?? null) as Field | null }
  }

  identitiesOf(userId: string) {
    return this.many(
      `SELECT channel, external_id, bound_at FROM agent_identities WHERE user_id = ? ORDER BY bound_at DESC`,
      userId,
    ).map((r) => ({ channel: String(r.channel), externalId: String(r.external_id), boundAt: String(r.bound_at) }))
  }

  unbindIdentity(userId: string, channel: string, externalId: string) {
    this.run(`DELETE FROM agent_identities WHERE user_id = ? AND channel = ? AND external_id = ?`, userId, channel, externalId)
  }

  /** 一人一把外部钥匙：下载 Skill 时轮换，旧文件立刻失效。 */
  issueUserAgentKey(userId: string): { token: string; createdAt: string } {
    const token = `kb_${randomBytes(24).toString('hex')}`
    const createdAt = new Date().toISOString()
    this.run(`DELETE FROM user_agent_keys WHERE user_id = ?`, userId)
    this.run(
      `INSERT INTO user_agent_keys (user_id, token_hash, created_at) VALUES (?, ?, ?)`,
      userId,
      hashUserAgentKey(token),
      createdAt,
    )
    return { token, createdAt }
  }

  userOfAgentKey(token: string): User | null {
    const key = String(token || '').trim()
    if (!key.startsWith('kb_')) return null
    const row = this.one(
      `SELECT u.id, u.name, u.role, u.field, u.status
       FROM user_agent_keys k JOIN users u ON u.id = k.user_id
       WHERE k.token_hash = ?`,
      hashUserAgentKey(key),
    )
    if (!row) return null
    if (String(row.status ?? 'approved') !== 'approved') return null
    return { id: String(row.id), name: String(row.name), role: row.role as Role, field: (row.field ?? null) as Field | null }
  }

  userAgentKeyMeta(userId: string): { createdAt: string } | null {
    const row = this.one(`SELECT created_at FROM user_agent_keys WHERE user_id = ?`, userId)
    return row ? { createdAt: String(row.created_at) } : null
  }

  revokeUserAgentKey(userId: string) {
    this.run(`DELETE FROM user_agent_keys WHERE user_id = ?`, userId)
  }

  // ---- 注册 / 审批 ----

  createPendingUser(row: {
    name: string
    employeeNo?: string
    passwordHash: string
    title?: string
    department?: string
    applyNote?: string
  }): string | null {
    if (this.findUserByName(row.name)) return null
    if (row.employeeNo && this.findUserByLogin(row.employeeNo)) return null
    const id = newId('u')
    this.run(
      `INSERT INTO users (id, name, employee_no, password_hash, role, field, title, department, status, applied_at, apply_note)
       VALUES (?, ?, ?, ?, 'guest', NULL, ?, ?, 'pending', ?, ?)`,
      id,
      row.name,
      row.employeeNo ?? row.name,
      row.passwordHash,
      row.title ?? null,
      row.department ?? null,
      new Date().toISOString(),
      row.applyNote ?? null,
    )
    return id
  }

  pendingUsers() {
    return this.many(
      `SELECT id, name, employee_no, title, department, applied_at, apply_note FROM users WHERE status = 'pending' ORDER BY applied_at DESC`,
    ).map((r) => ({
      id: String(r.id),
      name: String(r.name),
      employeeNo: r.employee_no == null ? null : String(r.employee_no),
      title: r.title == null ? null : String(r.title),
      department: r.department == null ? null : String(r.department),
      appliedAt: r.applied_at == null ? null : String(r.applied_at),
      note: r.apply_note == null ? null : String(r.apply_note),
    }))
  }

  // ---- 项目 / 项目成员（唯一权限来源）----

  insertProject(row: { id: string; name: string; note?: string | null }) {
    this.run(
      `INSERT INTO projects (id, name, status, note, created_at) VALUES (?, ?, 'active', ?, ?)`,
      row.id,
      row.name,
      row.note ?? null,
      new Date().toISOString(),
    )
  }

  listProjects() {
    return this.many(`SELECT id, name, status, note, created_at FROM projects ORDER BY status, id`).map((r) => ({
      id: String(r.id),
      name: String(r.name),
      status: String(r.status),
      note: r.note == null ? null : String(r.note),
      createdAt: String(r.created_at),
    }))
  }

  projectById(id: string) {
    const r = this.one(`SELECT id, name, status, note, created_at FROM projects WHERE id = ?`, id)
    return r
      ? {
          id: String(r.id),
          name: String(r.name),
          status: String(r.status),
          note: r.note == null ? null : String(r.note),
          createdAt: String(r.created_at),
        }
      : null
  }

  updateProject(id: string, patch: { name?: string; status?: string; note?: string | null }) {
    if (patch.name !== undefined) this.run(`UPDATE projects SET name = ? WHERE id = ?`, patch.name, id)
    if (patch.status !== undefined) this.run(`UPDATE projects SET status = ? WHERE id = ?`, patch.status, id)
    if (patch.note !== undefined) this.run(`UPDATE projects SET note = ? WHERE id = ?`, patch.note, id)
  }

  addProjectMember(projectId: string, userId: string, role: 'lead' | 'member') {
    this.run(
      `INSERT INTO project_members (project_id, user_id, role, added_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(project_id, user_id) DO UPDATE SET role = excluded.role`,
      projectId,
      userId,
      role,
      new Date().toISOString(),
    )
  }

  removeProjectMember(projectId: string, userId: string) {
    this.run(`DELETE FROM project_members WHERE project_id = ? AND user_id = ?`, projectId, userId)
  }

  projectMembers(projectId: string) {
    return this.many(
      `SELECT m.user_id, m.role, m.added_at, u.name, u.role AS user_role
       FROM project_members m LEFT JOIN users u ON u.id = m.user_id
       WHERE m.project_id = ? ORDER BY m.role, u.name`,
      projectId,
    ).map((r) => ({
      userId: String(r.user_id),
      name: r.name == null ? String(r.user_id) : String(r.name),
      role: String(r.role),
      addedAt: String(r.added_at),
    }))
  }

  /** 某人在某个项目里的角色（不在项目里返回 null） */
  projectRoleOf(projectId: string, userId: string): 'lead' | 'member' | null {
    const r = this.one(`SELECT role FROM project_members WHERE project_id = ? AND user_id = ?`, projectId, userId)
    if (!r) return null
    return String(r.role) === 'lead' ? 'lead' : 'member'
  }

  /** 某人参与的 active 项目 id 列表 */
  projectsOfUser(userId: string): string[] {
    return this.many(
      `SELECT p.id FROM project_members m JOIN projects p ON p.id = m.project_id
       WHERE m.user_id = ? AND p.status = 'active' ORDER BY p.id`,
      userId,
    ).map((r) => String(r.id))
  }

  /** 改登记条目的归属项目 */
  updateDocProject(id: string, projectId: string | null) {
    this.run(`UPDATE docs SET project_id = ? WHERE id = ?`, projectId, id)
  }

  /** 删一条文档登记（只删登记表，不动 GBrain） */
  deleteDoc(id: string) {
    this.run(`DELETE FROM docs WHERE id = ?`, id)
  }

  /** 按 GBrain slug（存在 source_path 里）找登记条目 */
  docIdsBySourcePath(slug: string): string[] {
    return this.many(`SELECT id FROM docs WHERE source_path = ?`, slug).map((r) => String(r.id))
  }

  /** 删用户：连带清掉会话与外部身份绑定 */
  deleteUser(id: string) {
    const sessions = this.many(`SELECT id FROM chat_sessions WHERE user_id = ?`, id)
    for (const r of sessions) this.deleteChatSession(String(r.id))
    this.run(`DELETE FROM auth_sessions WHERE user_id = ?`, id)
    this.run(`DELETE FROM agent_identities WHERE user_id = ?`, id)
    this.run(`DELETE FROM bind_codes WHERE user_id = ?`, id)
    this.run(`DELETE FROM user_agent_keys WHERE user_id = ?`, id)
    this.run(`DELETE FROM users WHERE id = ?`, id)
  }

  /** 还剩几个主人（防把最后一个主人删掉） */
  ownerCount(): number {
    const row = this.one(`SELECT COUNT(*) AS n FROM users WHERE role = 'owner' AND status = 'approved'`)
    return Number(row?.n ?? 0)
  }

  findUserByIdPlain(id: string): { id: string; name: string; role: Role; status: string } | null {
    const row = this.one(`SELECT id, name, role, status FROM users WHERE id = ?`, id)
    return row
      ? { id: String(row.id), name: String(row.name), role: row.role as Role, status: String(row.status ?? 'approved') }
      : null
  }

  approveUser(id: string, role: Role, field: Field | null) {
    this.run(`UPDATE users SET status = 'approved', role = ?, field = ? WHERE id = ?`, role, field, id)
  }

  rejectUser(id: string) {
    this.run(`UPDATE users SET status = 'rejected' WHERE id = ?`, id)
  }

  confirmedDocs(): { id: string; title: string; slug: string; content: string; sourcePath: string | null }[] {
    return this.many(
      `SELECT id, title, slug, content, source_path FROM docs WHERE status = 'confirmed' AND slug IS NOT NULL`,
    ).map((r) => ({
      id: String(r.id),
      title: String(r.title),
      slug: String(r.slug),
      content: String(r.content ?? ''),
      sourcePath: r.source_path == null ? null : String(r.source_path),
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

  /** 同一个人 + 同一问题在 N 小时内是否已经入队过（防刷屏） */
  recentQuestionExists(askedById: string, question: string, hours = 24): boolean {
    const row = this.one(
      `SELECT COUNT(*) AS n FROM questions WHERE asked_by_id = ? AND question = ? AND created_at > datetime('now', ?)`,
      askedById,
      question,
      `-${hours} hours`,
    )
    return Number(row?.n ?? 0) > 0
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
    projectId: r.project_id == null ? null : String(r.project_id),
    submittedBy: r.submitted_by == null ? null : String(r.submitted_by),
    submittedVia: r.submitted_via == null ? null : String(r.submitted_via),
    submitterAgent: r.submitter_agent == null ? null : String(r.submitter_agent),
    id: String(r.id),
    title: String(r.title),
    field: r.field as Field,
    sensitivity: r.sensitivity as Sensitivity,
    status: String(r.status) as 'pending' | 'confirmed' | 'rejected',
    updatedAt: String(r.updated_at),
    suggestedField: r.suggested_field == null ? undefined : (r.suggested_field as Field),
    suggestedSensitivity: r.suggested_sensitivity == null ? undefined : (r.suggested_sensitivity as Sensitivity),
    slug: r.slug == null ? undefined : String(r.slug),
    rejectReason: r.reject_reason == null || String(r.reject_reason) === '' ? undefined : String(r.reject_reason),
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
  updated_at TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'web'
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
CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  note TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS project_members (
  project_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'member',
  added_at TEXT NOT NULL,
  PRIMARY KEY (project_id, user_id)
);

CREATE TABLE IF NOT EXISTS bind_codes (
  code TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS agent_identities (
  channel TEXT NOT NULL,
  external_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  bound_at TEXT NOT NULL,
  PRIMARY KEY (channel, external_id)
);
CREATE TABLE IF NOT EXISTS user_agent_keys (
  user_id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL,
  created_at TEXT NOT NULL
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

// 老库兼容：补 users 的注册字段（SQLite 没有 ADD COLUMN IF NOT EXISTS，先查再加）
const userCols = new Set(
  (db.prepare('PRAGMA table_info(users)').all() as { name: string }[]).map((c) => String(c.name)),
)
for (const [col, ddl] of [
  ['title', 'ALTER TABLE users ADD COLUMN title TEXT'],
  ['department', 'ALTER TABLE users ADD COLUMN department TEXT'],
  ['status', "ALTER TABLE users ADD COLUMN status TEXT NOT NULL DEFAULT 'approved'"],
  ['applied_at', 'ALTER TABLE users ADD COLUMN applied_at TEXT'],
  ['apply_note', 'ALTER TABLE users ADD COLUMN apply_note TEXT'],
  ['employee_no', 'ALTER TABLE users ADD COLUMN employee_no TEXT'],
] as const) {
  if (!userCols.has(col)) db.exec(ddl)
}
// 工号：老账号先用姓名回填（admin/游客/纪祥祥 立刻能用原名字当工号登录），再加唯一索引
db.exec("UPDATE users SET employee_no = name WHERE employee_no IS NULL OR employee_no = ''")
db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_users_employee_no ON users(employee_no)')

// docs 加提交人信息（回查用）：submitted_by / submitted_via / submitter_agent
{
  const cols = new Set(
    (db.prepare('PRAGMA table_info(docs)').all() as { name: string }[]).map((c) => String(c.name)),
  )
  for (const [col, ddl] of [
    ['submitted_by', 'ALTER TABLE docs ADD COLUMN submitted_by TEXT'],
    ['submitted_via', 'ALTER TABLE docs ADD COLUMN submitted_via TEXT'],
    ['submitter_agent', 'ALTER TABLE docs ADD COLUMN submitter_agent TEXT'],
  ] as const) {
    if (!cols.has(col)) db.exec(ddl)
  }
  db.exec(`UPDATE docs SET submitted_via = 'legacy' WHERE submitted_via IS NULL`)
}

// docs / questions 加 project_id（NULL = 公共/全局）
for (const [table, col] of [
  ['docs', 'project_id'],
  ['questions', 'project_id'],
] as const) {
  const cols = new Set(
    (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => String(c.name)),
  )
  if (!cols.has(col)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} TEXT`)
}

const sessionCols = new Set(
  (db.prepare('PRAGMA table_info(chat_sessions)').all() as { name: string }[]).map((c) => String(c.name)),
)
if (!sessionCols.has('source')) db.exec(`ALTER TABLE chat_sessions ADD COLUMN source TEXT NOT NULL DEFAULT 'web'`)

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
