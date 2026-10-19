/**
 * 日结定期清理：删掉工作脑里过期的日结页（daily/ 前缀），保留经验条目。
 * 用法：
 *   tsx scripts/daily-cleanup.ts --source xiaoa-work --days 30            # 预览（默认 dry-run）
 *   tsx scripts/daily-cleanup.ts --source xiaoa-work --days 30 --apply   # 真删
 *   --files 同时删掉 ~/kb-daily 下对应文件
 */
import { spawn } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const GBRAIN = process.env.GBRAIN_BIN || join(homedir(), '.local/bin/gbrain')

function run(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(GBRAIN, args, { shell: false })
    const out: Buffer[] = []
    const err: Buffer[] = []
    child.stdout.on('data', (b: Buffer) => out.push(b))
    child.stderr.on('data', (b: Buffer) => err.push(b))
    child.on('close', (code) =>
      code === 0 ? resolve(Buffer.concat(out).toString('utf8')) : reject(new Error(Buffer.concat(err).toString('utf8'))),
    )
  })
}

function argOf(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback
}

async function main() {
  const source = argOf('source', '')
  const days = Number(argOf('days', '30'))
  const apply = process.argv.includes('--apply')
  const withFiles = process.argv.includes('--files')
  if (!source) {
    console.error('用法: tsx scripts/daily-cleanup.ts --source <source> [--days 30] [--apply] [--files]')
    process.exit(1)
  }
  const cutoff = Date.now() - days * 86400_000
  const listing = await run(['list', '--type', 'note', '--limit', '2000', '--source-id', source]).catch(() => '')
  const slugs = listing
    .split('\n')
    .map((l) => l.split('\t')[0].trim())
    .filter((s) => s.startsWith('daily/'))

  const old: string[] = []
  for (const slug of slugs) {
    // slug: daily/<YYYY-MM-DD>-<agent>
    const m = /daily\/(\d{4})-(\d{2})-(\d{2})/.exec(slug)
    if (!m) continue
    const t = Date.parse(`${m[1]}-${m[2]}-${m[3]}T00:00:00+08:00`)
    if (Number.isFinite(t) && t < cutoff) old.push(slug)
  }

  console.log(JSON.stringify({ source, days, apply, withFiles, candidates: old }, null, 1))
  if (!apply || old.length === 0) {
    console.log('（dry-run：加 --apply 才会真删）')
    return
  }
  for (const slug of old) {
    await run(['delete', slug, '--source-id', source, '--force']).then(
      () => console.log('deleted', slug),
      (e: Error) => console.error('fail', slug, e.message.slice(0, 120)),
    )
  }
  if (withFiles) {
    const dir = join(homedir(), 'kb-daily')
    if (existsSync(dir)) {
      for (const f of readdirSync(dir)) {
        const m = /(\d{4}-\d{2}-\d{2})/.exec(f)
        if (m && Date.parse(`${m[1]}T00:00:00+08:00`) < cutoff) {
          rmSync(join(dir, f), { force: true })
          console.log('file removed', f)
        }
      }
    }
  }
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
