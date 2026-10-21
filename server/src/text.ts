import { readFile } from 'node:fs/promises'
import { extname } from 'node:path'
import type { AppConfig, Field, Sensitivity } from './config.js'

export function guessField(text: string, config: AppConfig): Field {
  for (const field of ['electrical', 'dispatch', 'mechanical'] as Field[]) {
    if (config.keywords[field].some((word) => word && text.includes(word))) return field
  }
  return config.defaults.field
}

export function guessSensitivity(text: string, config: AppConfig): Sensitivity {
  if (config.sensitivityKeywords.top_secret.some((word) => word && text.includes(word))) return 'top_secret'
  if (config.sensitivityKeywords.confidential.some((word) => word && text.includes(word))) return 'confidential'
  if (config.sensitivityKeywords.public.some((word) => word && text.includes(word))) return 'public'
  return config.defaults.sensitivity
}

/**
 * 去掉疑问说法后再交给 GBrain。中文问题没有空格，整句去匹配会错过正文里的设备名。
 * 只删配置里的短语（至少两个字），不用单字去切。删完没剩内容就用原句。
 */
export function searchQueryOf(text: string, phrases: string[]): string {
  const original = text.trim()
  if (!original) return ''
  const sorted = phrases.filter((phrase) => phrase.length >= 2).sort((a, b) => b.length - a.length)
  let out = original
  for (const phrase of sorted) out = out.split(phrase).join(' ')
  out = out.replace(/[？?！!。，,、；;：:\s]+/g, ' ').trim()
  return out || original
}

const CJK_RUN = /[㐀-䶿一-鿿豈-﫿]+/g
const TALK_TAIL = /[呀啊呢哈哦吧啦嘛咯诶么吖]+$/g

function compactTalk(text: string): string {
  return text.trim().toLowerCase().replace(/[！!。.?？,，、；;：:\s]+/g, '')
}

/** 整句是打招呼、道谢时不检索知识库。含设备名的长句不会误判。 */
export function isSmallTalk(text: string, phrases: string[]): boolean {
  const n = compactTalk(text)
  if (!n || n.length > 16) return false
  const stem = n.replace(TALK_TAIL, '')
  const sorted = phrases.filter((p) => compactTalk(p).length >= 1).sort((a, b) => b.length - a.length)
  for (const phrase of sorted) {
    const p = compactTalk(phrase)
    if (stem === p || n === p) return true
    if (stem === `${p}你` || stem === `${p}您`) return true
  }
  return false
}

/**
 * 关键词补查 / 整页覆盖率用的词袋，不是语义检索的查询串。
 * 首轮应把去口语后的原句交给 GBrain（bge-m3）；只有 0 命中才用这里的
 * 整段 + 二字组 + 三字组 做关键词或匹配。数字/字母段（F009、16MPa）原样保留。
 */
export function searchTermsOf(query: string): string {
  const terms = new Set<string>()
  const singleChars: string[] = []
  for (const word of query.split(/\s+/).filter(Boolean)) {
    const cjkRuns = word.match(CJK_RUN) ?? []
    for (const ascii of word.replace(CJK_RUN, ' ').split(/\s+/).filter(Boolean)) terms.add(ascii)
    for (const run of cjkRuns) {
      if (run.length === 1) {
        singleChars.push(run)
        continue
      }
      terms.add(run)
      for (let i = 0; i + 2 <= run.length; i++) terms.add(run.slice(i, i + 2))
      for (let i = 0; i + 3 <= run.length; i++) terms.add(run.slice(i, i + 3))
    }
  }
  if (terms.size === 0) for (const ch of singleChars) terms.add(ch)
  return [...terms].join(' ')
}

/**
 * 覆盖率只用型号/英文，以及完整中文片段，不再切二字组。
 * 二字组会让「我们/自研」在无关页上覆盖率虚高，压过 GBrain 的语义第一名。
 */
export function coverageTermsOf(query: string): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  const add = (value: string) => {
    const t = value.trim()
    if (t.length < 2 || seen.has(t)) return
    seen.add(t)
    out.push(t)
  }
  for (const ascii of query.match(/[A-Za-z0-9][A-Za-z0-9._-]*/g) ?? []) add(ascii)
  for (const run of query.match(CJK_RUN) ?? []) add(run)
  return out
}

/**
 * multipart 文件名：busboy 默认按 latin1 解参数，UTF-8 中文会变成 ä¿å 这种。
 * 已是汉字的保持不动；把「UTF-8 字节被当成 latin1」的串还原。
 */
export function decodeUploadName(name: string): string {
  const trimmed = name.trim()
  if (!trimmed) return 'file'
  if (/[\u4e00-\u9fff]/.test(trimmed)) return trimmed
  const asUtf8 = Buffer.from(trimmed, 'latin1').toString('utf8')
  if (asUtf8.includes('\uFFFD')) return trimmed
  const cjk = (asUtf8.match(/[\u4e00-\u9fff]/g) ?? []).length
  if (cjk > 0) return asUtf8
  return trimmed
}

export function asciiSlug(title: string, id: string): string {
  const ascii = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40)
  return `${ascii || 'doc'}-${id.slice(-6)}`
}

export function toMarkdown(
  title: string,
  field: Field,
  sensitivity: Sensitivity,
  body: string,
  originName?: string,
  meta?: { author?: string | null; via?: string | null; project?: string | null },
): string {
  const safeTitle = title.replace(/"/g, '\\"')
  // 原件留在服务器上（data/inbox），页面里登记文件名，检索时能顺藤摸到原件
  const origin = originName ? `\n---\n\n> **原件**：${originName}（kb-web 上传，原件保存在服务器 data/inbox/）\n` : ''
  const metaLines = [
    meta?.author ? `author: "${meta.author}"` : '',
    meta?.via ? `submitted_via: "${meta.via}"` : '',
    meta?.project ? `project: "${meta.project}"` : '',
    `submitted_at: "${new Date().toISOString()}"`,
  ]
    .filter(Boolean)
    .join('\n')
  return `---\ntitle: "${safeTitle}"\ntype: note\ntags:\n  - ${field}\n  - ${sensitivity}\n${metaLines}\n---\n\n${body.trim()}\n${origin}`
}

/**
 * 判「告知/陈述」而不是「提问」。默认当提问（设备名、短句都要检索）。
 * 只有明确「记录/改成了/告知」口吻才当陈述。questionWords 放 config.yaml。
 */
export function looksLikeStatement(text: string, questionWords: string[]): boolean {
  const n = (text || '').trim()
  if (!n) return false
  if (/[?？]/.test(n)) return false
  const low = n.toLowerCase()
  for (const w of questionWords) {
    const word = String(w || '').trim().toLowerCase()
    if (word && low.includes(word)) return false
  }
  if (/记录一下|改成了|已经把|告知[:：]|备注[:：]/.test(n)) return n.length >= 8
  if (/^我.+(了|成)/.test(n) && n.length >= 10) return true
  return false
}

export async function extractText(filePath: string, filename: string): Promise<string> {
  const ext = extname(filename).toLowerCase()
  if (ext === '.md' || ext === '.txt') return readFile(filePath, 'utf8')
  if (ext === '.docx') {
    const mammoth = await import('mammoth')
    const result = await mammoth.extractRawText({ path: filePath })
    return result.value
  }
  if (ext === '.pdf') {
    const pdfParse = (await import('pdf-parse')).default as (data: Buffer) => Promise<{ text: string }>
    const data = await readFile(filePath)
    const result = await pdfParse(data)
    return result.text
  }
  if (ext === '.xlsx' || ext === '.xls' || ext === '.xlsm') {
    const xlsx = await import('xlsx')
    const book = xlsx.read(await readFile(filePath), { type: 'buffer' })
    return book.SheetNames.map((name) => xlsx.utils.sheet_to_csv(book.Sheets[name])).join('\n')
  }
  throw Object.assign(new Error('只支持 pdf、docx、xlsx、xls、xlsm、md、txt'), { status: 400 })
}

const WIKI = /\[\[([^\]|#]+)(?:#[^\]|]+)?(?:\|[^\]]+)?\]\]/g
const KB = /kb:\/\/([A-Za-z0-9._/-]+)/g

export function linkedSlugs(markdown: string): string[] {
  const found = new Set<string>()
  for (const match of markdown.matchAll(WIKI)) found.add(match[1].trim())
  for (const match of markdown.matchAll(KB)) found.add(match[1].trim())
  return [...found]
}
