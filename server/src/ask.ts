import { readFileSync } from 'node:fs'
import type { WebSocket } from 'ws'
import { canSee, parseSlug } from './access.js'
import { confidenceOf, type AppConfig, type Field, type Sensitivity, type User } from './config.js'
import { KbDb, newId } from './db.js'
import { GBrainError, searchGBrain } from './gbrain.js'
import { describeImages, LlmError, streamAnswer } from './llm.js'
import { searchQueryOf } from './text.js'

interface AskMessage {
  type: 'ask'
  questionId: string
  question: string
  sessionId?: string
  attachments?: { id: string; url: string; name: string; mimeType: string; size: number }[]
}

interface Run {
  abort: AbortController
  cancelled: boolean
}

const runs = new Map<WebSocket, Map<string, Run>>()

function send(ws: WebSocket, msg: unknown) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg))
}

function chunkText(text: string, size = 24): string[] {
  const parts: string[] = []
  for (let i = 0; i < text.length; i += size) parts.push(text.slice(i, i + size))
  return parts.length ? parts : ['']
}

export function cancelAsk(ws: WebSocket, questionId: string) {
  const run = runs.get(ws)?.get(questionId)
  if (!run) return
  run.cancelled = true
  run.abort.abort()
}

export function cancelAll(ws: WebSocket) {
  const map = runs.get(ws)
  if (!map) return
  for (const run of map.values()) {
    run.cancelled = true
    run.abort.abort()
  }
  runs.delete(ws)
}

export async function handleAsk(ws: WebSocket, user: User, db: KbDb, config: AppConfig, msg: AskMessage) {
  const questionId = msg.questionId
  const abort = new AbortController()
  const run: Run = { abort, cancelled: false }
  let socketRuns = runs.get(ws)
  if (!socketRuns) {
    socketRuns = new Map()
    runs.set(ws, socketRuns)
  }
  socketRuns.set(questionId, run)

  const finish = () => socketRuns!.delete(questionId)
  try {
    const question = (msg.question ?? '').trim()
    const attachments = msg.attachments ?? []
    if (!question && attachments.length === 0) {
      send(ws, { type: 'error', questionId, message: '请输入问题或上传照片' })
      return
    }
    if (attachments.length > config.vision.maxImages) {
      send(ws, { type: 'error', questionId, message: `一次最多 ${config.vision.maxImages} 张照片` })
      return
    }

    let sessionId = msg.sessionId
    if (sessionId && !db.getChatSession(sessionId, user.id)) sessionId = undefined
    if (!sessionId) sessionId = newId('s')
    send(ws, { type: 'status', questionId, phase: 'retrieving' })

    let photoNote = ''
    if (attachments.length) {
      const images = []
      for (const item of attachments) {
        const row = db.getUpload(item.id)
        if (!row || row.userId !== user.id) {
          send(ws, { type: 'error', questionId, message: '照片不存在或无权使用' })
          return
        }
        images.push({ mime: row.mime, data: readFileSync(row.path) })
      }
      photoNote = await describeImages(config, images, abort.signal)
    }
    if (run.cancelled) return

    const query = searchQueryOf(question, config.search.questionPhrases) || searchQueryOf(photoNote, config.search.questionPhrases)
    const hits = await collectHits(config, user, query)
    const askedAt = new Date().toISOString()

    if (hits.length === 0) {
      const text = config.noEvidence.text
      const confidence = { level: 'low' as const, score: config.noEvidence.score }
      send(ws, { type: 'status', questionId, phase: 'no_evidence' })
      for (const part of chunkText(text)) send(ws, { type: 'delta', questionId, text: part })
      send(ws, { type: 'confidence', questionId, ...confidence })
      persist(db, user, sessionId, question, attachments, text, [], confidence, askedAt, questionId, ws)
      send(ws, { type: 'done', questionId })
      return
    }

    send(ws, { type: 'status', questionId, phase: 'generating' })
    const citations = hits.map((hit, i) => ({
      id: hit.slug,
      title: hit.title,
      path: `kb://${hit.slug}`,
      snippet: hit.chunkText.slice(0, 240),
      field: hit.field,
      sensitivity: hit.sensitivity,
      marker: `[${i + 1}]`,
    }))
    for (const citation of citations) send(ws, { type: 'citation', questionId, citation })

    const history = db.recentMessages(sessionId, 6).map((m) => ({ role: m.role, content: m.text }))
    const evidence = hits
      .map((hit, i) => `[${i + 1}] ${hit.title}\n${hit.chunkText}`)
      .join('\n\n')
    const userContent = `${photoNote ? `照片中可见：\n${photoNote}\n\n` : ''}资料：\n${evidence}\n\n问题：\n${question || '请结合照片和资料说明'}`
    let answer = ''
    await streamAnswer(
      config,
      [{ role: 'system', content: config.prompts.qa }, ...history, { role: 'user', content: userContent }],
      (text) => {
        answer += text
        send(ws, { type: 'delta', questionId, text })
      },
      abort.signal,
    )
    if (run.cancelled) {
      persist(db, user, sessionId, question, attachments, answer, citations, undefined, askedAt, questionId, ws)
      send(ws, { type: 'done', questionId })
      return
    }
    const confidence = confidenceOf(hits[0].score, config)
    send(ws, { type: 'confidence', questionId, ...confidence })
    persist(db, user, sessionId, question, attachments, answer, citations, confidence, askedAt, questionId, ws)
    for (const hit of hits) {
      const doc = db.findDocBySlug(hit.slug)
      if (doc) db.addDocRef(doc.id, sessionId, question || '[照片咨询]', askedAt)
    }
    send(ws, { type: 'done', questionId })
  } catch (err) {
    if (run.cancelled || (err as Error).name === 'AbortError') {
      send(ws, { type: 'done', questionId })
      return
    }
    const message = err instanceof LlmError || err instanceof GBrainError ? err.message : '回答失败，请重试'
    send(ws, { type: 'error', questionId, message })
  } finally {
    finish()
  }
}

interface KeptHit {
  slug: string
  title: string
  chunkText: string
  score: number
  field: Field
  sensitivity: Sensitivity
}

async function collectHits(config: AppConfig, user: User, query: string) {
  const seen = new Set<string>()
  const hits: KeptHit[] = []
  for (let page = 0; page < config.search.maxPages && hits.length < config.search.keep; page++) {
    const rows = await searchGBrain(config, query, config.search.fetchLimit, page * config.search.fetchLimit)
    if (rows.length === 0) break
    for (const row of rows) {
      const parsed = parseSlug(row.slug)
      if (!parsed || seen.has(row.slug) || !canSee(user, parsed.field, parsed.sensitivity)) continue
      seen.add(row.slug)
      hits.push({ ...row, field: parsed.field, sensitivity: parsed.sensitivity })
      if (hits.length >= config.search.keep) break
    }
  }
  return hits
}

function persist(
  db: KbDb,
  user: User,
  sessionId: string,
  question: string,
  attachments: AskMessage['attachments'],
  answer: string,
  citations: unknown[],
  confidence: { level: string; score: number } | undefined,
  createdAt: string,
  questionId: string,
  ws: WebSocket,
) {
  if (!db.getChatSession(sessionId, user.id)) {
    db.insertChatSession({
      id: sessionId,
      userId: user.id,
      title: question.slice(0, 20) || '[照片咨询]',
      preview: '',
      updatedAt: createdAt,
    })
    send(ws, { type: 'session', questionId, sessionId })
  }
  db.insertMessage({
    id: newId('m'),
    sessionId,
    role: 'user',
    text: question,
    attachments,
    createdAt,
  })
  db.insertMessage({
    id: newId('m'),
    sessionId,
    role: 'assistant',
    text: answer,
    citations,
    confidence,
    createdAt,
  })
  db.touchChatSession(sessionId, answer.slice(0, 50), createdAt)
}

export function contextOf(db: KbDb, sessionId: string | undefined, userId: string): string | undefined {
  if (!sessionId || !db.getChatSession(sessionId, userId)) return undefined
  return db
    .recentMessages(sessionId, 6)
    .map((m) => `${m.role === 'user' ? '问' : '答'}：${m.text}`)
    .join('\n')
    .slice(0, 2000)
}
