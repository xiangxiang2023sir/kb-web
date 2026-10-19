import { spawn } from 'node:child_process'
import type { AppConfig } from './config.js'

export class GBrainError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'GBrainError'
  }
}

export interface GBrainHit {
  slug: string
  title: string
  chunkText: string
  score: number
}

/** 参数数组调用，不经过 shell，避免问题文本被拼进命令。 */
export function runGBrain(config: AppConfig, args: string[], timeoutMs = config.gbrain.timeoutMs): Promise<string> {
  const command = config.gbrain.command
  const full = [...config.gbrain.argsPrefix, ...args]
  return new Promise((resolve, reject) => {
    let child
    try {
      child = spawn(command, full, { shell: false, windowsHide: true })
    } catch (err) {
      reject(new GBrainError(`无法启动 GBrain（${command}）：${(err as Error).message}`))
      return
    }
    const out: Buffer[] = []
    const err: Buffer[] = []
    let settled = false
    const done = (fn: () => void) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      fn()
    }
    const timer = setTimeout(() => {
      child.kill()
      done(() => reject(new GBrainError('GBrain 执行超时')))
    }, timeoutMs)
    child.stdout.on('data', (b) => out.push(b))
    child.stderr.on('data', (b) => err.push(b))
    child.on('error', (e) => {
      const missing = (e as NodeJS.ErrnoException).code === 'ENOENT'
      done(() =>
        reject(
          new GBrainError(
            missing
              ? `找不到命令 ${command}。请在 config.yaml 的 gbrain.command 填写可执行文件`
              : e.message,
          ),
        ),
      )
    })
    child.on('close', (code) => {
      const stdout = Buffer.concat(out).toString('utf8')
      const stderr = Buffer.concat(err).toString('utf8').trim()
      if (code !== 0) {
        // GBrain 出错时有时把 JSON 错误写在 stdout、stderr 为空，尽量取出 message
        let detail = stderr
        if (!detail) {
          try {
            const parsed = JSON.parse(stdout) as { message?: unknown; error?: unknown }
            detail = String(parsed.message ?? parsed.error ?? '')
          } catch {
            /* stdout 不是 JSON 就算了 */
          }
        }
        done(() => reject(new GBrainError(detail || `GBrain 退出码 ${code}`)))
        return
      }
      done(() => resolve(stdout))
    })
  })
}

function parseJson(stdout: string): unknown {
  const text = stdout.trim()
  if (!text) return null
  try {
    return JSON.parse(text)
  } catch {
    const start = Math.min(...['[', '{'].map((c) => {
      const i = text.indexOf(c)
      return i < 0 ? Number.POSITIVE_INFINITY : i
    }))
    if (!Number.isFinite(start)) throw new GBrainError('GBrain 没有返回 JSON')
    return JSON.parse(text.slice(start))
  }
}

export async function searchGBrain(config: AppConfig, query: string, limit: number, offset: number): Promise<GBrainHit[]> {
  const stdout = await runGBrain(config, ['search', query, '--limit', String(limit), '--offset', String(offset), '--json'])
  const parsed = parseJson(stdout)
  const rows = Array.isArray(parsed) ? parsed : Array.isArray((parsed as { results?: unknown })?.results) ? (parsed as { results: unknown[] }).results : []
  return rows
    .map((row) => {
      const r = row as Record<string, unknown>
      return {
        slug: String(r.slug ?? ''),
        title: String(r.title ?? r.slug ?? ''),
        chunkText: String(r.chunk_text ?? r.chunkText ?? ''),
        score: Number(r.score ?? 0),
      }
    })
    .filter((r) => r.slug)
}

export async function captureGBrain(config: AppConfig, file: string, slug: string) {
  // --force：同 slug 重复确认（重新入库）时直接替换旧页，否则 GBrain 报 revision_required
  await runGBrain(config, ['capture', '--file', file, '--slug', slug, '--force'], config.gbrain.timeoutMs * 2)
}

export async function orphanGBrain(config: AppConfig): Promise<{ slug: string; title: string }[]> {
  const stdout = await runGBrain(config, ['orphans', '--json'])
  const parsed = parseJson(stdout) as { orphans?: { slug?: string; title?: string }[] } | null
  return (parsed?.orphans ?? []).map((o) => ({ slug: String(o.slug ?? ''), title: String(o.title ?? o.slug ?? '') })).filter((o) => o.slug)
}

export interface GBrainPage {
  slug: string
  title: string
}

export async function listGBrain(config: AppConfig): Promise<GBrainPage[]> {
  const stdout = await runGBrain(config, ['list'])
  // 每行格式: slug\ttype\tdate\ttitle
  return stdout
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('No pages'))
    .map((line) => {
      const parts = line.split('\t')
      return {
        slug: parts[0] ?? '',
        title: parts[3] ?? parts[0] ?? '',
      }
    })
    .filter((p) => p.slug)
}
