import { loadEnvFile } from './src/config.js'
import { openDb, newId } from './src/db.js'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

loadEnvFile()
const db = openDb(join(process.cwd(), 'data', 'kb.sqlite'))
// 用法: tsx submit-summary.ts <md> <标题> <提交人> <领域> <source名>
const [file, title, who, field, sourceName] = process.argv.slice(2)
if (!file || !title) { console.error('用法: tsx submit-summary.ts <md> <标题> <提交人> <领域> <source>'); process.exit(1) }
const fullTitle = `[日终总结] ${title}`
const existed = db.listDocs({ keyword: fullTitle, hideTopSecret: false }).find((d) => d.title === fullTitle)
if (existed) { console.log(JSON.stringify({ ok: true, duplicate: true, id: existed.id })); process.exit(0) }
const f = (field === 'dispatch' || field === 'mechanical') ? field : 'electrical'
const id = newId('d')
db.insertDoc({
  id, title: fullTitle, field: f, sensitivity: 'internal', status: 'pending',
  suggestedField: f, suggestedSensitivity: 'internal',
  content: `${readFileSync(file, 'utf8')}\n\n---\n\n- 来源：agent 日终总结（工作脑 ${sourceName ?? '-'}）\n- 提交人：${who ?? '-'}\n- 提交时间：${new Date().toISOString()}`,
  updatedAt: new Date().toISOString(),
})
console.log(JSON.stringify({ ok: true, id, title: fullTitle, field: f, status: db.getDoc(id)?.status }))
