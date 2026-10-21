import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse } from 'yaml'

export type Role = 'owner' | 'admin' | 'operator' | 'guest'
export type Field = 'electrical' | 'dispatch' | 'mechanical'
export type Sensitivity = 'public' | 'internal' | 'confidential' | 'top_secret'
export type ConfidenceLevel = 'high' | 'medium' | 'low'

export interface User {
  id: string
  name: string
  role: Role
  field: Field | null
}

const FIELDS: Field[] = ['electrical', 'dispatch', 'mechanical']
const SENSITIVITIES: Sensitivity[] = ['public', 'internal', 'confidential', 'top_secret']

export interface AppConfig {
  auth: { cookieName: string; ttlDays: number }
  search: {
    fetchLimit: number
    keep: number
    maxPages: number
    questionPhrases: string[]
    /** 取整页重排的候选条数（GBrain 名次靠前的这些） */
    rerankCandidates: number
    /** 整页命中覆盖率在排序里的权重 */
    coverageWeight: number
    /** 每条资料送进模型的字数上限 */
    pageChars: number
    /** 弱相关过滤：候选得分低于「头部得分 × 该比例」的丢掉（避免凑数引用） */
    minRankRatio: number
    /** 弱相关过滤：查询词在页面里的覆盖率下限（低于它视为跑题） */
    minCoverage: number
  }
  confidence: { highMin: number; mediumMin: number }
  noEvidence: { text: string; score: number }
  agent?: {
    /** true=外部 agent 只看 public/internal（默认 false，按账号权限） */
    publicOnlyOnly?: boolean
  }
  questions?: {
    /** 外部通道（agent/飞书）问不到资料时，自动进问题队列 */
    autoQueueFromAgent?: boolean
    /** 同人同问题多少小时内不重复入队 */
    dedupeHours?: number
    /** 只有能看到全部活跃项目时才自动入队（权限受限不入队） */
    requireFullAccess?: boolean
  }
  chat: {
    phrases: string[]
    fallback: string
    ackText: string
    questionWords: string[]
    /** 送给模型的最近消息条数（问+答都算） */
    historyTurns: number
    /** 每人最多保留的会话数，超出删最旧的 */
    maxSessions: number
    /** 单场最多多少轮（一轮=一问一答），超出自动新开 */
    maxTurnsPerSession: number
    /** 外部 agent 不带 sessionId 时，空闲多久内接到上一场 */
    agentIdleHours: number
    /** 周归档：一周里至少这么多条消息才写文件 */
    archiveMinMessages: number
  }
  keywords: Record<Field, string[]>
  sensitivityKeywords: { top_secret: string[]; confidential: string[]; public: string[] }
  defaults: { field: Field; sensitivity: Sensitivity }
  llm: { baseUrl: string; model: string; temperature: number; maxTokens: number }
  vision: { baseUrl: string; model: string; maxImages: number }
  gbrain: { command: string; argsPrefix: string[]; timeoutMs: number }
  health: { reportIslandedPages: boolean }
  limits: { imageBytes: number; docBytes: number; classifyChars: number }
  prompts: { qa: string; classify: string; vision: string; chat: string }
  feishu: { groupOnlyMention: boolean }
}

export const serverRoot = fileURLToPath(new URL('..', import.meta.url))

function asStringArray(v: unknown): string[] {
  return Array.isArray(v) ? v.map((x) => String(x)) : []
}

function asField(v: unknown, fallback: Field): Field {
  return FIELDS.includes(v as Field) ? (v as Field) : fallback
}

function asSensitivity(v: unknown, fallback: Sensitivity): Sensitivity {
  return SENSITIVITIES.includes(v as Sensitivity) ? (v as Sensitivity) : fallback
}

export function isField(v: unknown): v is Field {
  return FIELDS.includes(v as Field)
}

export function isSensitivity(v: unknown): v is Sensitivity {
  return SENSITIVITIES.includes(v as Sensitivity)
}

export function isRole(v: unknown): v is Role {
  return v === 'owner' || v === 'admin' || v === 'operator' || v === 'guest'
}

/** 读取 server/.env，不覆盖进程里已经存在的变量。 */
export function loadEnvFile() {
  const path = join(serverRoot, '.env')
  if (!existsSync(path)) return
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const t = line.trim()
    if (!t || t.startsWith('#')) continue
    const i = t.indexOf('=')
    if (i < 0) continue
    const key = t.slice(0, i).trim()
    let value = t.slice(i + 1).trim()
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1)
    }
    if (process.env[key] === undefined) process.env[key] = value
  }
}

export function loadConfig(): AppConfig {
  const path = process.env.KB_CONFIG ?? join(serverRoot, 'config.yaml')
  const raw = parse(readFileSync(path, 'utf8')) as Record<string, any>
  const read = (name: string) => readFileSync(join(serverRoot, 'prompts', name), 'utf8').trim()
  return {
    auth: {
      cookieName: String(raw.auth?.cookieName ?? 'kb_sid'),
      ttlDays: Number(raw.auth?.ttlDays ?? 7),
    },
    search: {
      fetchLimit: Number(raw.search?.fetchLimit ?? 30),
      keep: Number(raw.search?.keep ?? 5),
      maxPages: Number(raw.search?.maxPages ?? 2),
      questionPhrases:
        raw.search?.questionPhrases == null
          ? ['怎么处理', '如何处理', '怎么办', '如何', '是什么']
          : asStringArray(raw.search.questionPhrases),
      rerankCandidates: Number(raw.search?.rerankCandidates ?? 12),
      coverageWeight: Number(raw.search?.coverageWeight ?? 0.6),
      pageChars: Number(raw.search?.pageChars ?? 4000),
      minRankRatio: Number(raw.search?.minRankRatio ?? 0),
      minCoverage: Number(raw.search?.minCoverage ?? 0),
    },
    confidence: {
      highMin: Number(raw.confidence?.highMin ?? 0.03),
      mediumMin: Number(raw.confidence?.mediumMin ?? 0.015),
    },
    noEvidence: {
      text: String(raw.noEvidence?.text ?? ''),
      score: Number(raw.noEvidence?.score ?? 0.2),
    },
    chat: {
      phrases:
        raw.chat?.phrases == null
          ? ['你好', '您好', '嗨', 'hi', 'hello', '在吗', '谢谢', '再见', '你是谁', '你能做什么']
          : asStringArray(raw.chat.phrases),
      fallback: String(
        raw.chat?.fallback ?? '你好，我是工厂知识库助手。问设备、规程或故障时我会按资料回答。',
      ),
      ackText: String(raw.chat?.ackText ?? '知道了。要不要把这条存进知识库？'),
      questionWords:
        raw.chat?.questionWords == null
          ? ['怎么', '如何', '为什么', '是什么', '什么', '多少', '在哪', '哪里', '哪个', '能不能', '是否', '有没有', '吗']
          : asStringArray(raw.chat.questionWords),
      historyTurns: Number(raw.chat?.historyTurns ?? 8),
      maxSessions: Number(raw.chat?.maxSessions ?? 50),
      maxTurnsPerSession: Number(raw.chat?.maxTurnsPerSession ?? 100),
      agentIdleHours: Number(raw.chat?.agentIdleHours ?? 8),
      archiveMinMessages: Number(raw.chat?.archiveMinMessages ?? 4),
    },
    keywords: {
      electrical: asStringArray(raw.keywords?.electrical),
      mechanical: asStringArray(raw.keywords?.mechanical),
      dispatch: asStringArray(raw.keywords?.dispatch),
    },
    sensitivityKeywords: {
      top_secret: asStringArray(raw.sensitivityKeywords?.top_secret),
      confidential: asStringArray(raw.sensitivityKeywords?.confidential),
      public: asStringArray(raw.sensitivityKeywords?.public),
    },
    defaults: {
      field: asField(raw.defaults?.field, 'electrical'),
      sensitivity: asSensitivity(raw.defaults?.sensitivity, 'internal'),
    },
    llm: {
      baseUrl: String(raw.llm?.baseUrl ?? 'https://api.deepseek.com').replace(/\/$/, ''),
      model: String(raw.llm?.model ?? 'deepseek-chat'),
      temperature: Number(raw.llm?.temperature ?? 0.2),
      maxTokens: Number(raw.llm?.maxTokens ?? 2000),
    },
    vision: {
      baseUrl: String(raw.vision?.baseUrl ?? '').replace(/\/$/, ''),
      model: String(raw.vision?.model ?? ''),
      maxImages: Number(raw.vision?.maxImages ?? 4),
    },
    gbrain: {
      command: process.env.GBRAIN_BIN || String(raw.gbrain?.command ?? 'gbrain'),
      argsPrefix: asStringArray(raw.gbrain?.argsPrefix),
      timeoutMs: Number(raw.gbrain?.timeoutMs ?? 25000),
    },
    health: { reportIslandedPages: raw.health?.reportIslandedPages === true },
    limits: {
      imageBytes: Number(raw.limits?.imageBytes ?? 10 * 1024 * 1024),
      docBytes: Number(raw.limits?.docBytes ?? 20 * 1024 * 1024),
      classifyChars: Number(raw.limits?.classifyChars ?? 6000),
    },
    prompts: {
      qa: read('qa.md'),
      classify: read('classify.md'),
      vision: read('vision.md'),
      chat: read('chat.md'),
    },
    questions: {
      autoQueueFromAgent: raw.questions?.autoQueueFromAgent !== false,
      dedupeHours: Number(raw.questions?.dedupeHours ?? 24),
      requireFullAccess: raw.questions?.requireFullAccess !== false,
    },
    agent: { publicOnlyOnly: raw.agent?.publicOnlyOnly === true },
    feishu: { groupOnlyMention: raw.feishu?.groupOnlyMention !== false },
  }
}

export function confidenceOf(score: number, config: AppConfig): { level: ConfidenceLevel; score: number } {
  // GBrain 关键词分经常远大于 1（多词或匹配会到几千），前端按 0–1 显示百分比，这里压住
  const shown = Number.isFinite(score) ? Math.max(0, Math.min(1, score)) : 0
  if (score >= config.confidence.highMin) return { level: 'high', score: shown }
  if (score >= config.confidence.mediumMin) return { level: 'medium', score: shown }
  return { level: 'low', score: shown }
}
