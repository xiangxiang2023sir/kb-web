const args = process.argv.slice(2)
const cmd = args[0]

if (cmd === 'search') {
  const query = args[1] ?? ''
  if (query.includes('空结果')) {
    console.log('[]')
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

if (cmd === 'capture') {
  console.log('ok')
  process.exit(0)
}

if (cmd === 'orphans') {
  console.log(JSON.stringify({ orphans: [] }))
  process.exit(0)
}

console.error('unknown', args.join(' '))
process.exit(1)
