import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { AppConfig } from './config.js'
import { type KbDb, newId } from './db.js'
import { guessField, guessSensitivity } from './text.js'

const WEEK_RE = /^\d{4}-W\d{2}$/
const USER_RE = /^[a-zA-Z0-9_-]+$/

/** ISO 周，例如 2026-W42。一周从周一开始。 */
export function isoWeekKey(d: Date): string {
  const date = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()))
  const day = date.getUTCDay() || 7
  date.setUTCDate(date.getUTCDate() + 4 - day)
  const year = date.getUTCFullYear()
  const yearStart = new Date(Date.UTC(year, 0, 1))
  const week = Math.ceil(((date.getTime() - yearStart.getTime()) / 86400000 + 1) / 7)
  return `${year}-W${String(week).padStart(2, '0')}`
}

export function previousIsoWeekKey(now = new Date()): string {
  return isoWeekKey(new Date(now.getTime() - 7 * 86400000))
}

export function isoWeekRange(weekKey: string): { start: string; end: string } {
  const m = WEEK_RE.exec(weekKey)
  if (!m) throw new Error('周次格式不对')
  const year = Number(weekKey.slice(0, 4))
  const week = Number(weekKey.slice(6))
  const jan4 = new Date(Date.UTC(year, 0, 4))
  const day = jan4.getUTCDay() || 7
  const monday = new Date(jan4)
  monday.setUTCDate(jan4.getUTCDate() - day + 1 + (week - 1) * 7)
  const end = new Date(monday)
  end.setUTCDate(monday.getUTCDate() + 7)
  return { start: monday.toISOString(), end: end.toISOString() }
}

export function archiveFilePath(dataDir: string, userId: string, weekKey: string): string {
  return join(dataDir, 'archives', userId, `${weekKey}.md`)
}

export interface ArchiveItem {
  userId: string
  userName: string
  weekKey: string
  title: string
  bytes: number
  createdAt: string
}

function safeIds(userId: string, weekKey: string): boolean {
  return USER_RE.test(userId) && WEEK_RE.test(weekKey)
}

/** 把上一 ISO 周的对话写成本机文件。已有文件默认跳过，不进正式库。 */
export function writeWeeklyArchives(
  db: KbDb,
  dataDir: string,
  config: AppConfig,
  opts?: { weekKey?: string; force?: boolean },
): { weekKey: string; files: number } {
  const weekKey = opts?.weekKey ?? previousIsoWeekKey()
  const { start, end } = isoWeekRange(weekKey)
  const min = Math.max(2, Number(config.chat.archiveMinMessages) || 4)
  const sessions = db.sessionsWithMessagesBetween(start, end)
  const byUser = new Map<string, typeof sessions>()
  for (const s of sessions) {
    const list = byUser.get(s.userId) ?? []
    list.push(s)
    byUser.set(s.userId, list)
  }
  let files = 0
  for (const [userId, rows] of byUser) {
    const parts: string[] = []
    let count = 0
    for (const session of rows) {
      const messages = db
        .listMessages(session.id)
        .filter((m) => m.createdAt >= start && m.createdAt < end)
      if (messages.length < 2) continue
      count += messages.length
      const source = session.source === 'agent' ? '外部' : '网页'
      parts.push(`## ${session.title}（${source}）\n`)
      for (const m of messages) {
        parts.push(m.role === 'user' ? `### 问\n\n${m.text}\n` : `### 答\n\n${m.text}\n`)
      }
    }
    if (count < min || !parts.length) continue
    const userName = rows[0]?.userName || userId
    const path = archiveFilePath(dataDir, userId, weekKey)
    if (existsSync(path) && !opts?.force) {
      files += 1
      continue
    }
    mkdirSync(join(dataDir, 'archives', userId), { recursive: true })
    const body = [
      `# 对话归档 ${userName} ${weekKey}`,
      '',
      '本周网页与外部 agent 的问答摘录。未进正式库。可在网页「历史会话」送入待确认。',
      '',
      ...parts,
    ].join('\n')
    writeFileSync(path, body, 'utf8')
    files += 1
  }
  return { weekKey, files }
}

export function listArchives(db: KbDb, dataDir: string): ArchiveItem[] {
  const root = join(dataDir, 'archives')
  if (!existsSync(root)) return []
  const out: ArchiveItem[] = []
  for (const userId of readdirSync(root)) {
    if (!USER_RE.test(userId)) continue
    const dir = join(root, userId)
    let stat
    try {
      stat = statSync(dir)
    } catch {
      continue
    }
    if (!stat.isDirectory()) continue
    const user = db.findUserById(userId)
    for (const name of readdirSync(dir)) {
      if (!name.endsWith('.md')) continue
      const weekKey = name.slice(0, -3)
      if (!WEEK_RE.test(weekKey)) continue
      const path = join(dir, name)
      let file
      try {
        file = statSync(path)
      } catch {
        continue
      }
      if (!file.isFile()) continue
      const userName = user?.name ?? userId
      out.push({
        userId,
        userName,
        weekKey,
        title: `对话归档 ${userName} ${weekKey}`,
        bytes: file.size,
        createdAt: file.mtime.toISOString(),
      })
    }
  }
  out.sort((a, b) => (a.weekKey === b.weekKey ? a.userName.localeCompare(b.userName) : b.weekKey.localeCompare(a.weekKey)))
  return out
}

export function readArchive(dataDir: string, userId: string, weekKey: string): string | null {
  if (!safeIds(userId, weekKey)) return null
  const path = archiveFilePath(dataDir, userId, weekKey)
  if (!existsSync(path)) return null
  return readFileSync(path, 'utf8')
}

/** 把周归档送进待确认，不直接入库。 */
export function archiveToPending(
  db: KbDb,
  dataDir: string,
  config: AppConfig,
  userId: string,
  weekKey: string,
  submittedBy: string,
): { id: string; duplicate?: boolean; title: string } {
  const markdown = readArchive(dataDir, userId, weekKey)
  if (!markdown) throw new Error('归档不存在')
  const owner = db.findUserById(userId)
  const title = `[对话归档] ${owner?.name ?? userId} ${weekKey}`.slice(0, 80)
  const existing = db.listDocs({ keyword: title, hideTopSecret: false }).find((d) => d.title === title)
  if (existing) return { id: existing.id, duplicate: true, title }
  const id = newId('d')
  const content = `${markdown}\n\n---\n\n- 来源：周归档\n- 提问人：${owner?.name ?? userId}\n- 提交人：${submittedBy}\n- 周次：${weekKey}`
  db.insertDoc({
    id,
    title,
    field: guessField(markdown, config),
    sensitivity: 'internal',
    status: 'pending',
    suggestedField: guessField(markdown, config),
    suggestedSensitivity: guessSensitivity(markdown, config),
    content,
    updatedAt: new Date().toISOString(),
  })
  return { id, title }
}
