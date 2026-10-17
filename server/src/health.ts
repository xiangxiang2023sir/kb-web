import { parse } from 'yaml'
import type { AppConfig } from './config.js'
import { KbDb, newId } from './db.js'
import { GBrainError, orphanGBrain } from './gbrain.js'
import { linkedSlugs } from './text.js'

export interface HealthIssue {
  id: string
  type: 'dead_link' | 'orphan_reference' | 'format'
  docId: string
  docTitle: string
  detail: string
}

/** 规程多数彼此不链接，所以默认只检查我们自己入库的正文，不把「没有入链」当成故障。 */
export async function runHealth(db: KbDb, config: AppConfig): Promise<HealthIssue[]> {
  const issues: HealthIssue[] = []
  const docs = db.confirmedDocs()
  const slugs = new Set(docs.map((d) => d.slug))

  for (const doc of docs) {
    const body = doc.content
    if (!body.startsWith('---')) {
      issues.push({
        id: newId('h'),
        type: 'format',
        docId: doc.id,
        docTitle: doc.title,
        detail: '正文缺少 frontmatter',
      })
      continue
    }
    const end = body.indexOf('\n---', 3)
    if (end < 0) {
      issues.push({
        id: newId('h'),
        type: 'format',
        docId: doc.id,
        docTitle: doc.title,
        detail: 'frontmatter 没有结束标记',
      })
      continue
    }
    try {
      const fm = parse(body.slice(4, end)) as { title?: unknown }
      if (!fm || typeof fm !== 'object' || !fm.title) {
        issues.push({
          id: newId('h'),
          type: 'format',
          docId: doc.id,
          docTitle: doc.title,
          detail: 'frontmatter 缺少 title',
        })
      }
    } catch (err) {
      issues.push({
        id: newId('h'),
        type: 'format',
        docId: doc.id,
        docTitle: doc.title,
        detail: `frontmatter 无法解析：${(err as Error).message}`,
      })
    }

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

  return issues
}
