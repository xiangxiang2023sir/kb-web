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
  search: { fetchLimit: number; keep: number; maxPages: number }
  confidence: { highMin: number; mediumMin: number }
  noEvidence: { text: string; score: number }
  keywords: Record<Field, string[]>
  sensitivityKeywords: { top_secret: string[]; confidential: string[]; public: string[] }
  defaults: { field: Field; sensitivity: Sensitivity }
  llm: { baseUrl: string; model: string; temperature: number; maxTokens: number }
  vision: { baseUrl: string; model: string; maxImages: number }
  gbrain: { command: string; argsPrefix: string[]; timeoutMs: number }
  health: { reportIslandedPages: boolean }
  limits: { imageBytes: number; docBytes: number; classifyChars: number }
  prompts: { qa: string; classify: string; vision: string }
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
    },
    confidence: {
      highMin: Number(raw.confidence?.highMin ?? 0.03),
      mediumMin: Number(raw.confidence?.mediumMin ?? 0.015),
    },
    noEvidence: {
      text: String(raw.noEvidence?.text ?? ''),
      score: Number(raw.noEvidence?.score ?? 0.2),
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
    prompts: { qa: read('qa.md'), classify: read('classify.md'), vision: read('vision.md') },
  }
}

export function confidenceOf(score: number, config: AppConfig): { level: ConfidenceLevel; score: number } {
  if (score >= config.confidence.highMin) return { level: 'high', score }
  if (score >= config.confidence.mediumMin) return { level: 'medium', score }
  return { level: 'low', score }
}
