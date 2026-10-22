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
  console.log(JSON.stringify({ orphans: [] }))
  process.exit(0)
}

console.error('unknown', args.join(' '))
process.exit(1)
