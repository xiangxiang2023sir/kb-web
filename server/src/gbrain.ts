import { spawn } from 'node:child_process'
import { homedir } from 'node:os'
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
  sourceId?: string
}

/** 参数数组调用，不经过 shell，避免问题文本被拼进命令。 */
export function runGBrain(config: AppConfig, args: string[], timeoutMs = config.gbrain.timeoutMs): Promise<string> {
  const command = config.gbrain.command
  const full = [...config.gbrain.argsPrefix, ...args]
  return new Promise((resolve, reject) => {
    let child
    if (process.env.KB_DEBUG_GBRAIN === '1') console.error(`[gb] RUN ${command} ${full.join(' ').slice(0, 400)}`)
    try {
      // stdin 关掉：避免非 TTY 下升级提示拖住查询向量的 6 秒预算。
      // cwd 指 HOME：和手工 shell 同一份 PGLite，不跟 kb-web 的工作目录走。
      child = spawn(command, full, {
        shell: false,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: process.env,
        cwd: process.env.HOME || homedir(),
      })
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
      if (process.env.KB_DEBUG_GBRAIN === '1') {
        const j = full[0] === 'search' ? stdout.slice(0, 400) : ''
        console.error(`[gb] DONE code=${code} len=${stdout.length} ${j ? 'head=' + j.replace(/\s+/g, ' ') : ''}`)
      }
      const stderr = Buffer.concat(err).toString('utf8').trim()
      if (stderr && /embed_timeout|DEGRADED|query embed/i.test(stderr)) {
        console.error(`[gb] stderr ${stderr.slice(0, 800)}`)
      }
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

/** 查询向量超时会静默改走关键词，必须把 _meta 打出来才能对上手工 CLI。 */
function retrievalMetaOf(parsed: unknown): { degraded: unknown[]; vectorEnabled: boolean | null; cache: string } {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { degraded: [], vectorEnabled: null, cache: '-' }
  }
  const meta = (parsed as { _meta?: { retrieval?: Record<string, unknown> } })._meta?.retrieval
  if (!meta) return { degraded: [], vectorEnabled: null, cache: '-' }
  const degraded = Array.isArray(meta.degraded) ? meta.degraded : []
  const cache = meta.cache
  const cacheStatus =
    typeof cache === 'string' ? cache : cache && typeof cache === 'object' && 'status' in cache ? String((cache as { status?: unknown }).status ?? '-') : '-'
  return {
    degraded,
    vectorEnabled: typeof meta.vector_enabled === 'boolean' ? meta.vector_enabled : null,
    cache: cacheStatus,
  }
}

export async function searchGBrain(
  config: AppConfig,
  query: string,
  limit: number,
  offset: number,
  sourceId?: string,
): Promise<GBrainHit[]> {
  const stdout = await runGBrain(config, ['search', query, '--limit', String(limit), '--offset', String(offset), '--json', ...(sourceId ? ['--source-id', sourceId] : [])])
  const parsed = parseJson(stdout)
  const rows = Array.isArray(parsed) ? parsed : Array.isArray((parsed as { results?: unknown })?.results) ? (parsed as { results: unknown[] }).results : []
  const retrieval = retrievalMetaOf(parsed)
  if (retrieval.degraded.length || process.env.KB_DEBUG_GBRAIN === '1') {
    const sl = (rows as Record<string, unknown>[]).slice(0, 4).map((r) => `${Number(r.score ?? 0).toFixed(3)}:${String(r.slug ?? '').slice(-40)}`)
    console.error(
      `[gb] SRC=${sourceId ?? '-'} rows=${rows.length} vector=${retrieval.vectorEnabled} cache=${retrieval.cache} degraded=${JSON.stringify(retrieval.degraded)} q="${query.slice(0, 40)}" top=${sl.join(' , ')}`,
    )
  }
  return rows
    .map((row) => {
      const r = row as Record<string, unknown>
      return {
        slug: String(r.slug ?? ''),
        sourceId: r.source_id == null ? undefined : String(r.source_id),
        title: String(r.title ?? r.slug ?? ''),
        chunkText: String(r.chunk_text ?? r.chunkText ?? ''),
        score: Number(r.score ?? 0),
      }
    })
    .filter((r) => r.slug)
}

/**
 * 读整页正文。search 只回一片 chunk，页面后段的结论会被截掉，
 * 所以候选命中要再取一次整页，交给模型通读。
 */
export async function pageBodyGBrain(config: AppConfig, slug: string, sourceId?: string): Promise<string> {
  // 注意：新版 gbrain 的 --body 必须带值（auto/none），否则报 invalid_params
  const stdout = await runGBrain(config, ['get', slug, '--body', 'auto', ...(sourceId ? ['--source-id', sourceId] : [])], Math.min(config.gbrain.timeoutMs, 20000))
  return stripPageOutput(stdout)
}

/** 去掉升级提示等非正文行，以及 YAML frontmatter。 */
function stripPageOutput(stdout: string): string {
  const lines = stdout.split('\n').filter((line) => {
    const t = line.trim()
    if (t.startsWith('UPGRADE_AVAILABLE')) return false
    if (/^gbrain \S+ -> \S+ available/.test(t)) return false
    if (t.includes('self-upgrade')) return false
    if (t.startsWith('[gbrain]')) return false
    return true
  })
  let text = lines.join('\n').trim()
  if (text.startsWith('---')) {
    const end = text.indexOf('\n---', 3)
    if (end > 0) text = text.slice(end + 4).trim()
  }
  return text
}

export async function captureGBrain(config: AppConfig, file: string, slug: string, sourceId?: string | null) {
  // --force：同 slug 重复确认（重新入库）时直接替换旧页，否则 GBrain 报 revision_required
  // --source：有项目就写进该项目的 source，没有就进 default（公共库）
  const args = ['capture', '--file', file, '--slug', slug, '--force']
  if (sourceId) args.push('--source', sourceId)
  await runGBrain(config, args, config.gbrain.timeoutMs * 2)
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

export interface GBrainStats {
  pageCount: number
  chunkCount: number
  embeddedCount: number
  linkCount: number
  tagCount: number
  timelineCount: number
  byType: Record<string, number>
}

/** gbrain stats --json → 库状态汇总 */
export async function gbrainStats(config: AppConfig): Promise<GBrainStats> {
  const raw = await runGBrain(config, ['stats', '--json'])
  let j: Record<string, unknown> = {}
  try {
    j = JSON.parse(raw) as Record<string, unknown>
  } catch {
    return { pageCount: 0, chunkCount: 0, embeddedCount: 0, linkCount: 0, tagCount: 0, timelineCount: 0, byType: {} }
  }
  const n = (k: string) => Number(j[k] ?? 0) || 0
  return {
    pageCount: n('page_count'),
    chunkCount: n('chunk_count'),
    embeddedCount: n('embedded_count'),
    linkCount: n('link_count'),
    tagCount: n('tag_count'),
    timelineCount: n('timeline_entry_count'),
    byType: (j.pages_by_type as Record<string, number>) ?? {},
  }
}

export interface GBrainPageFull {
  slug: string
  title: string
  type: string
  updatedAt: string | null
  sourceId: string
}

/** gbrain list --json → 带类型和更新时间的完整清单 */
export async function listGBrainFull(config: AppConfig, sourceId = '__all__'): Promise<GBrainPageFull[]> {
  const raw = await runGBrain(
    config,
    ['list', '--limit', '1000', '--json', '--source-id', sourceId],
    Math.max(config.gbrain.timeoutMs, 120000),
  )
  try {
    const rows = JSON.parse(raw) as { slug?: string; title?: string; type?: string; updated_at?: string; source_id?: string }[]
    return rows
      .filter((r) => r.slug)
      .map((r) => ({
        slug: String(r.slug),
        title: String(r.title ?? r.slug),
        type: String(r.type ?? 'page'),
        updatedAt: r.updated_at ? String(r.updated_at) : null,
        sourceId: String(r.source_id ?? 'default'),
      }))
  } catch {
    const plain = await listGBrain(config)
    return plain.map((p) => ({ slug: p.slug, title: p.title, type: 'page', updatedAt: null, sourceId: 'default' }))
  }
}

/** 删一个页（硬删：行 + 分块 + 磁盘 md 一起） */
export async function deleteGBrainPage(config: AppConfig, slug: string, sourceId?: string): Promise<void> {
  await runGBrain(
    config,
    ['delete', slug, '--force', '--purge', ...(sourceId ? ['--source-id', sourceId] : [])],
    Math.max(config.gbrain.timeoutMs, 120000),
  )
}

/** 多 source 检索：逐个 source 查再合并（按分数排序、slug 去重） */
export async function searchGBrainMulti(
  config: AppConfig,
  query: string,
  limit: number,
  offset: number,
  sources: string[],
): Promise<GBrainHit[]> {
  if (sources.length === 0) return []
  if (sources.length === 1) return searchGBrain(config, query, limit, offset, sources[0])
  // 多源：一次查 __all__ 再按 source_id 过滤
  // 原因：逐源各查一次要跑 N 次 embedding，慢好几倍，而且实测逐源拿回的是关键词结果、
  //       合并查才走语义（2026-10-21 实测：单源 9 条含手册页第1名；逐源 12 条无手册页）
  const res = await searchGBrain(config, query, limit, offset, '__all__')
  if (res.some((h) => h.sourceId)) {
    const allow = new Set(sources)
    return res.filter((h) => !h.sourceId || allow.has(h.sourceId))
  }
  // 老版本 gbrain 没返回 source_id：退回逐源查
  const all = await Promise.all(
    sources.map((s) => searchGBrain(config, query, limit, offset, s).catch(() => [] as GBrainHit[])),
  )
  const seen = new Set<string>()
  const merged: GBrainHit[] = []
  for (const hit of all.flat()) {
    if (seen.has(hit.slug)) continue
    seen.add(hit.slug)
    merged.push(hit)
  }
  // 不做按源归一化（会把弱源的头名抬到 1.0 压掉真正匹配的页），保留原始分排序
  return merged.sort((a, b) => b.score - a.score).slice(0, limit)
}
