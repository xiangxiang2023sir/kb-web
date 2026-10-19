import { readFileSync } from 'node:fs'
import type { WebSocket } from 'ws'
import { canSee, parseSlug } from './access.js'
import { confidenceOf, type AppConfig, type Field, type Sensitivity, type User } from './config.js'
import { KbDb, newId } from './db.js'
import { GBrainError, pageBodyGBrain, searchGBrain } from './gbrain.js'
import { describeImages, LlmError, streamAnswer } from './llm.js'
import { isSmallTalk, looksLikeStatement, searchQueryOf, searchTermsOf } from './text.js'

export interface AskMessage {
  type: 'ask'
  questionId: string
  question: string
  sessionId?: string
  attachments?: { id: string; url: string; name: string; mimeType: string; size: number }[]
}

export type AskEmit = (event: Record<string, unknown>) => void

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

/** 网站 WebSocket 入口。飞书等通道走 runAsk + 自己的 emit。 */
export async function handleAsk(ws: WebSocket, user: User, db: KbDb, config: AppConfig, msg: AskMessage) {
  const abort = new AbortController()
  const run: Run = { abort, cancelled: false }
  let socketRuns = runs.get(ws)
  if (!socketRuns) {
    socketRuns = new Map()
    runs.set(ws, socketRuns)
  }
  socketRuns.set(msg.questionId, run)
  try {
    await runAsk(user, db, config, msg, (event) => send(ws, event), run)
  } finally {
    socketRuns!.delete(msg.questionId)
  }
}

export async function runAsk(
  user: User,
  db: KbDb,
  config: AppConfig,
  msg: AskMessage,
  emit: AskEmit,
  run?: Run,
) {
  const questionId = msg.questionId
  const abort = run?.abort ?? new AbortController()
  const cancelled = () => run?.cancelled === true

  const question = (msg.question ?? '').trim()
  const attachments = msg.attachments ?? []
  if (!question && attachments.length === 0) {
    emit({ type: 'error', questionId, message: '请输入问题或上传照片' })
    return
  }
  if (attachments.length > config.vision.maxImages) {
    emit({ type: 'error', questionId, message: `一次最多 ${config.vision.maxImages} 张照片` })
    return
  }

  let sessionId = msg.sessionId
  if (sessionId && !db.getChatSession(sessionId, user.id)) sessionId = undefined
  if (!sessionId) sessionId = newId('s')

  try {
  emit({ type: 'status', questionId, phase: 'retrieving' })

  let photoNote = ''
  if (attachments.length) {
    const images = []
    for (const item of attachments) {
      const row = db.getUpload(item.id)
      if (!row || row.userId !== user.id) {
        emit({ type: 'error', questionId, message: '照片不存在或无权使用' })
        return
      }
      images.push({ mime: row.mime, data: readFileSync(row.path) })
    }
    photoNote = await describeImages(config, images, abort.signal)
  }
  if (cancelled()) return

  const askedAt = new Date().toISOString()
  if (!attachments.length && isSmallTalk(question, config.chat.phrases)) {
    emit({ type: 'status', questionId, phase: 'generating' })
    const history = db.recentMessages(sessionId, 6).map((m) => ({ role: m.role, content: m.text }))
    let answer = ''
    if (!process.env.DEEPSEEK_API_KEY) {
      answer = config.chat.fallback
      for (const part of chunkText(answer)) emit({ type: 'delta', questionId, text: part })
    } else {
      await streamAnswer(
        config,
        [{ role: 'system', content: config.prompts.chat }, ...history, { role: 'user', content: question }],
        (text) => {
          answer += text
          emit({ type: 'delta', questionId, text })
        },
        abort.signal,
      )
    }
    persist(db, user, sessionId, question, attachments, answer, [], undefined, askedAt, questionId, emit)
    emit({ type: 'done', questionId })
    return
  }

  // 不是提问而是「告知」：不查库，只回一句确认（前端会提示可存入知识库）
  if (!attachments.length && looksLikeStatement(question, config.chat.questionWords)) {
    const text = config.chat.ackText
    emit({ type: 'status', questionId, phase: 'acknowledged' })
    for (const part of chunkText(text)) emit({ type: 'delta', questionId, text: part })
    persist(db, user, sessionId, question, attachments, text, [], undefined, askedAt, questionId, emit)
    emit({ type: 'done', questionId })
    return
  }

  const stripped = searchQueryOf(question, config.search.questionPhrases) || searchQueryOf(photoNote, config.search.questionPhrases)
  const query = searchTermsOf(stripped)
  const hits = await collectHits(config, user, query)

  if (hits.length === 0) {
    const text = config.noEvidence.text
    const confidence = { level: 'low' as const, score: config.noEvidence.score }
    emit({ type: 'status', questionId, phase: 'no_evidence' })
    for (const part of chunkText(text)) emit({ type: 'delta', questionId, text: part })
    emit({ type: 'confidence', questionId, ...confidence })
    persist(db, user, sessionId, question, attachments, text, [], confidence, askedAt, questionId, emit)
    emit({ type: 'done', questionId })
    return
  }

  emit({ type: 'status', questionId, phase: 'generating' })
  const citations = hits.map((hit, i) => ({
    id: hit.slug,
    title: hit.title,
    path: `kb://${hit.slug}`,
    snippet: hit.chunkText.slice(0, 240),
    field: hit.field,
    sensitivity: hit.sensitivity,
    marker: `[${i + 1}]`,
  }))
  for (const citation of citations) emit({ type: 'citation', questionId, citation })

  const history = db.recentMessages(sessionId, 6).map((m) => ({ role: m.role, content: m.text }))
  const evidence = hits.map((hit, i) => `[${i + 1}] ${hit.title}\n${evidenceOf(hit, config.search.pageChars)}`).join('\n\n')
  const userContent = `${photoNote ? `照片中可见：\n${photoNote}\n\n` : ''}资料：\n${evidence}\n\n问题：\n${question || '请结合照片和资料说明'}`
  let answer = ''
  try {
    await streamAnswer(
      config,
      [{ role: 'system', content: config.prompts.qa }, ...history, { role: 'user', content: userContent }],
      (text) => {
        answer += text
        emit({ type: 'delta', questionId, text })
      },
      abort.signal,
    )
  } catch (err) {
    if (cancelled() || (err as Error).name === 'AbortError') {
      persist(db, user, sessionId, question, attachments, answer, citations, undefined, askedAt, questionId, emit)
      emit({ type: 'done', questionId })
      return
    }
    const message = err instanceof LlmError || err instanceof GBrainError ? err.message : '回答失败，请重试'
    emit({ type: 'error', questionId, message })
    return
  }
  if (cancelled()) {
    persist(db, user, sessionId, question, attachments, answer, citations, undefined, askedAt, questionId, emit)
    emit({ type: 'done', questionId })
    return
  }
  const confidence = confidenceOf(hits[0].score, config)
  emit({ type: 'confidence', questionId, ...confidence })
  persist(db, user, sessionId, question, attachments, answer, citations, confidence, askedAt, questionId, emit)
  for (const hit of hits) {
    const doc = db.findDocBySlug(hit.slug)
    if (doc) db.addDocRef(doc.id, sessionId, question || '[照片咨询]', askedAt)
  }
  emit({ type: 'done', questionId })
  } catch (err) {
    if (cancelled() || (err as Error).name === 'AbortError') {
      emit({ type: 'done', questionId })
      return
    }
    const message = err instanceof LlmError || err instanceof GBrainError ? err.message : '回答失败，请重试'
    emit({ type: 'error', questionId, message })
  }
}

interface KeptHit {
  slug: string
  title: string
  chunkText: string
  score: number
  field: Field
  sensitivity: Sensitivity
  /** 整页正文（取不到时为空，回落到 chunkText） */
  body?: string
  /** 重排名次分，只用于排序，不对外显示 */
  rank?: number
}

/**
 * 检索三步：
 * 1) GBrain 关键词检索，按领域/密级过滤，攒够 rerankCandidates 条候选；
 * 2) 候选逐条读整页正文（search 只给一片 chunk，结论常在页面后段）；
 * 3) 用「归一化 GBrain 分 + 整页命中覆盖率」重排，取前 keep 条给模型。
 */
async function collectHits(config: AppConfig, user: User, query: string) {
  const want = Math.max(config.search.rerankCandidates, config.search.keep)
  const seen = new Set<string>()
  const candidates: KeptHit[] = []
  for (let page = 0; page < config.search.maxPages && candidates.length < want; page++) {
    const rows = await searchGBrain(config, query, config.search.fetchLimit, page * config.search.fetchLimit)
    if (rows.length === 0) break
    for (const row of rows) {
      const parsed = parseSlug(row.slug)
      if (!parsed || seen.has(row.slug) || !canSee(user, parsed.field, parsed.sensitivity)) continue
      seen.add(row.slug)
      candidates.push({ ...row, field: parsed.field, sensitivity: parsed.sensitivity })
      if (candidates.length >= want) break
    }
  }
  if (candidates.length === 0) return candidates

  await fillBodies(config, candidates)

  const terms = query.split(/\s+/).filter(Boolean)
  const weightOf = (term: string) => (term.length >= 4 ? 3 : term.length === 3 ? 2 : 1)
  const totalWeight = terms.reduce((sum, term) => sum + weightOf(term), 0) || 1
  const maxScore = candidates.reduce((max, hit) => Math.max(max, hit.score), 0) || 1
  for (const hit of candidates) {
    const text = hit.body || hit.chunkText
    const covered = terms.reduce((sum, term) => (text.includes(term) ? sum + weightOf(term) : sum), 0)
    hit.rank = hit.score / maxScore + config.search.coverageWeight * (covered / totalWeight)
  }
  candidates.sort((a, b) => (b.rank ?? 0) - (a.rank ?? 0))
  return candidates.slice(0, config.search.keep)
}

/** 并发读整页，单个页面失败不影响其余候选。 */
async function fillBodies(config: AppConfig, hits: KeptHit[]) {
  const queue = [...hits]
  const worker = async () => {
    for (;;) {
      const hit = queue.shift()
      if (!hit) return
      try {
        hit.body = await pageBodyGBrain(config, hit.slug)
      } catch {
        hit.body = ''
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(4, hits.length) }, worker))
}

/**
 * 送进模型的资料正文：整页不超过上限就整页给；
 * 超长页（如几万字的规程汇编）按命中片段的位置取窗口，避免整段截掉结论。
 */
function evidenceOf(hit: KeptHit, pageChars: number): string {
  const body = hit.body || hit.chunkText
  if (body.length <= pageChars) return body
  const anchor = hit.chunkText.slice(0, 60)
  const at = anchor ? body.indexOf(anchor) : -1
  if (at < 0) return body.slice(0, pageChars)
  const start = Math.max(0, at - Math.floor(pageChars * 0.35))
  return `${start > 0 ? '（前面章节略）\n' : ''}${body.slice(start, start + pageChars)}`
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
  emit: AskEmit,
) {
  if (!db.getChatSession(sessionId, user.id)) {
    db.insertChatSession({
      id: sessionId,
      userId: user.id,
      title: question.slice(0, 20) || '[照片咨询]',
      preview: '',
      updatedAt: createdAt,
    })
    emit({ type: 'session', questionId, sessionId })
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
