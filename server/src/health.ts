import { parse } from 'yaml'
import { parseSlug } from './access.js'
import type { AppConfig } from './config.js'
import { KbDb, newId } from './db.js'
import { GBrainError, listGBrain, orphanGBrain } from './gbrain.js'
import { linkedSlugs } from './text.js'

export interface HealthIssue {
  id: string
  type: 'dead_link' | 'orphan_reference' | 'format'
  docId: string
  docTitle: string
  detail: string
}

/** 一次检查的摘要：预期行为用数字说明，不刷成几百条告警。 */
export interface HealthSummary {
  ledgerPages: number
  /** 台账里存了正文副本（capture→确认） */
  bodyInSqlite: number
  /** 正文仅在 GBrain（sync 登记），已跳过 frontmatter */
  bodyInGbrainOnly: number
  /** GBrain list 到的页数；list 失败则为 null */
  gbrainPages: number | null
  /** 台账有、GBrain 无 */
  missingInGbrain: number
  /** GBrain 有、台账无（只计数，不逐条落库） */
  missingInLedger: number
}

export interface HealthRunResult {
  issues: HealthIssue[]
  summary: HealthSummary
}

function pushFormat(issues: HealthIssue[], doc: { id: string; title: string }, detail: string) {
  issues.push({
    id: newId('h'),
    type: 'format',
    docId: doc.id,
    docTitle: doc.title,
    detail,
  })
}

function checkFrontmatter(issues: HealthIssue[], doc: { id: string; title: string }, body: string) {
  if (!body.startsWith('---')) {
    pushFormat(issues, doc, '正文缺少 frontmatter')
    return false
  }
  const end = body.indexOf('\n---', 3)
  if (end < 0) {
    pushFormat(issues, doc, 'frontmatter 没有结束标记')
    return false
  }
  try {
    const fm = parse(body.slice(4, end)) as { title?: unknown }
    if (!fm || typeof fm !== 'object' || !fm.title) {
      pushFormat(issues, doc, 'frontmatter 缺少 title')
    }
  } catch (err) {
    pushFormat(issues, doc, `frontmatter 无法解析：${(err as Error).message}`)
  }
  return true
}

/**
 * 健康检查（对齐双存储）：
 * - 空正文：正文在 GBrain，不查 frontmatter；只核 title/slug
 * - 有正文：查 frontmatter + 死链
 * - 台账↔GBrain：台账有而库无 → 告警；库有而台账无 → 只记 summary
 */
export async function runHealth(db: KbDb, config: AppConfig): Promise<HealthRunResult> {
  const issues: HealthIssue[] = []
  const docs = db.confirmedDocs()
  const slugs = new Set(docs.map((d) => d.slug))

  let bodyInSqlite = 0
  let bodyInGbrainOnly = 0

  for (const doc of docs) {
    const body = (doc.content ?? '').trim()

    if (!body) {
      bodyInGbrainOnly++
      if (!doc.title.trim()) pushFormat(issues, doc, '台账缺少标题')
      if (!doc.slug.trim()) pushFormat(issues, doc, '台账缺少 slug')
      else if (!parseSlug(doc.slug)) pushFormat(issues, doc, `slug 不符合 领域/密级/名字：${doc.slug}`)
      continue
    }

    bodyInSqlite++
    if (!checkFrontmatter(issues, doc, body)) continue

    for (const target of linkedSlugs(body)) {
      if (!slugs.has(target)) {
        issues.push({
          id: newId('h'),
          type: 'dead_link',
          docId: doc.id,
          docTitle: doc.title,
          detail: `链接指向不存在的页面：${target}`,
        })
      }
    }
  }

  let gbrainPages: number | null = null
  let missingInGbrain = 0
  let missingInLedger = 0

  try {
    const pages = await listGBrain(config)
    gbrainPages = pages.length
    const gbrainSlugs = new Set(pages.map((p) => p.slug))

    for (const doc of docs) {
      if (!doc.slug.trim()) continue
      if (!gbrainSlugs.has(doc.slug)) {
        missingInGbrain++
        pushFormat(issues, doc, `GBrain 中找不到此页（台账有登记）：${doc.slug}`)
      }
    }

    for (const page of pages) {
      if (!slugs.has(page.slug)) missingInLedger++
    }
    // 库有台账无：一条汇总即可，避免再刷屏
    if (missingInLedger > 0) {
      issues.push({
        id: newId('h'),
        type: 'format',
        docId: '_ledger',
        docTitle: '台账同步',
        detail: `GBrain 有 ${missingInLedger} 页未登记到台账，可在文档列表执行「从 GBrain 同步」`,
      })
    }
  } catch (err) {
    issues.push({
      id: newId('h'),
      type: 'format',
      docId: '_gbrain',
      docTitle: 'GBrain',
      detail: `无法列出 GBrain 页面，已跳过台账↔库对照：${err instanceof Error ? err.message : String(err)}`,
    })
  }

  if (config.health.reportIslandedPages) {
    try {
      const orphans = await orphanGBrain(config)
      for (const orphan of orphans) {
        const local = docs.find((d) => d.slug === orphan.slug)
        issues.push({
          id: newId('h'),
          type: 'orphan_reference',
          docId: local?.id ?? orphan.slug,
          docTitle: local?.title ?? orphan.title,
          detail: '页面没有任何入链或出链',
        })
      }
    } catch (err) {
      if (err instanceof GBrainError) throw err
      throw new GBrainError((err as Error).message)
    }
  }

  return {
    issues,
    summary: {
      ledgerPages: docs.length,
      bodyInSqlite,
      bodyInGbrainOnly,
      gbrainPages,
      missingInGbrain,
      missingInLedger,
    },
  }
}
