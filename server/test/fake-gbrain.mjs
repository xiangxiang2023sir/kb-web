import { existsSync, readFileSync, writeFileSync } from 'node:fs'

const args = process.argv.slice(2)
const cmd = args[0]
const stateFile = process.env.FAKE_GBRAIN_STATE
const builtin = ['default', 'tools', 'p-amr01', 'p-composite', 'p-hikrobot']

function loadSources() {
  const set = new Set(builtin)
  if (stateFile && existsSync(stateFile)) {
    try {
      const extra = JSON.parse(readFileSync(stateFile, 'utf8'))
      if (Array.isArray(extra)) for (const id of extra) set.add(String(id))
    } catch {
      /* 状态文件坏了就用内置 */
    }
  }
  return set
}

function saveSources(set) {
  if (!stateFile) return
  writeFileSync(stateFile, JSON.stringify([...set]))
}

if (cmd === 'search') {
  const query = args[1] ?? ''
  if (query.includes('空结果') || query === 'zzz') {
    console.log('[]')
  } else if (query.includes('绝密')) {
    console.log(
      JSON.stringify([
        {
          slug: 'electrical/top_secret/secret-page',
          title: '绝密页',
          chunk_text: '不该给外部 agent',
          score: 0.9,
        },
      ]),
    )
  } else {
    console.log(
      JSON.stringify([
        {
          slug: 'electrical/internal/inverter-f009',
          title: '变频器过载故障处理规程',
          chunk_text: '绝缘电阻应不小于 0.5MΩ',
          score: 0.05,
        },
      ]),
    )
  }
  process.exit(0)
}

if (cmd === 'sources' && args[1] === 'list') {
  const sources = [...loadSources()].map((id) => ({ id, local_path: `/tmp/${id}`, page_count: 0 }))
  console.log(JSON.stringify({ sources }))
  process.exit(0)
}

if (cmd === 'sources' && args[1] === 'add') {
  const id = args[2]
  const set = loadSources()
  if (id) set.add(id)
  saveSources(set)
  console.log('ok')
  process.exit(0)
}

if (cmd === 'capture') {
  const i = args.indexOf('--source')
  if (i >= 0) {
    const src = args[i + 1]
    const sources = loadSources()
    if (src && !sources.has(src)) {
      console.error(`gbrain capture: Source "${src}" not found or is archived.\nAvailable active sources: run \`gbrain sources list\``)
      process.exit(1)
    }
  }
  console.log('ok')
  process.exit(0)
}

if (cmd === 'orphans') {
  console.log(
    JSON.stringify({
      orphans: [
        { slug: 'mechanical/internal/orphan-note', title: '孤立备注' },
        { slug: 'electrical/top_secret/secret-page', title: '绝密页' },
      ],
    }),
  )
  process.exit(0)
}

if (cmd === 'list') {
  // 模拟真实 GBrain：不带 --source-id 时只打 default，常为 0 页
  const srcIdx = args.indexOf('--source-id')
  const sourceId = srcIdx >= 0 ? args[srcIdx + 1] : ''
  if (!sourceId) {
    console.log('No pages found')
    process.exit(0)
  }
  const pages = [
    {
      slug: 'electrical/internal/inverter-f009',
      title: '变频器过载故障处理规程',
      type: 'page',
      updated_at: '2026-01-01T00:00:00Z',
      source_id: 'default',
    },
    {
      slug: 'electrical/public/safety-basics',
      title: '电气安全基础',
      type: 'page',
      updated_at: '2026-01-02T00:00:00Z',
      source_id: 'default',
    },
    {
      slug: 'dispatch/internal/route-plan',
      title: '调度路径规划',
      type: 'page',
      updated_at: '2026-01-03T00:00:00Z',
      source_id: 'default',
    },
    {
      slug: 'mechanical/internal/orphan-note',
      title: '孤立备注',
      type: 'page',
      updated_at: '2026-01-04T00:00:00Z',
      source_id: 'default',
    },
    {
      slug: 'electrical/top_secret/secret-page',
      title: '绝密页',
      type: 'page',
      updated_at: '2026-01-05T00:00:00Z',
      source_id: 'default',
    },
  ]
  if (args.includes('--json')) {
    console.log(JSON.stringify(pages))
  } else {
    console.log(pages.map((p) => `${p.slug}\t${p.type}\t${p.updated_at.slice(0, 10)}\t${p.title}`).join('\n'))
  }
  process.exit(0)
}

if (cmd === 'graph') {
  // 真实 CLI：gbrain graph <slug> — slug 必填；不带 --source-id 常为空
  const slug = args[1]
  if (!slug || slug.startsWith('--')) {
    console.error("Error [invalid_params]: Missing required parameter 'slug' for 'gbrain graph'")
    process.exit(1)
  }
  const srcIdx = args.indexOf('--source-id')
  const sourceId = srcIdx >= 0 ? args[srcIdx + 1] : ''
  if (!sourceId) {
    console.log('[]')
    process.exit(0)
  }
  const all = [
    {
      slug: 'electrical/internal/inverter-f009',
      links: [{ to_slug: 'electrical/public/safety-basics', link_type: 'wikilink_basename' }],
    },
    {
      slug: 'electrical/public/safety-basics',
      links: [{ to_slug: 'dispatch/internal/route-plan', link_type: 'wikilink_basename' }],
    },
    {
      slug: 'dispatch/internal/route-plan',
      links: [{ to_slug: 'electrical/internal/inverter-f009', link_type: 'wikilink_basename' }],
    },
  ]
  const nodes = all.filter((n) => n.slug === slug || n.links.some((l) => l.to_slug === slug))
  // 起点自己也要带上（depth=1 邻域）
  if (!nodes.some((n) => n.slug === slug)) {
    const self = all.find((n) => n.slug === slug)
    if (self) nodes.unshift(self)
    else nodes.unshift({ slug, links: [] })
  }
  console.log(JSON.stringify(nodes))
  process.exit(0)
}

if (cmd === 'stats') {
  const linkCount = process.env.FAKE_GBRAIN_LINK_COUNT != null ? Number(process.env.FAKE_GBRAIN_LINK_COUNT) : 3
  console.log(
    JSON.stringify({
      page_count: 5,
      chunk_count: 10,
      embedded_count: 8,
      link_count: Number.isFinite(linkCount) ? linkCount : 3,
      tag_count: 0,
      timeline_entry_count: 0,
      pages_by_type: { page: 5 },
    }),
  )
  process.exit(0)
}

console.error('unknown', args.join(' '))
process.exit(1)
