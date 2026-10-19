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
 * 把检索词整理成 GBrain 能用的查询串。
 * 实测 GBrain search 是逐词子串匹配、词与词之间是「或」的关系：
 * 整句中文当一个词会错过正文（「液压油多久换一次」匹配不到任何文档），
 * 所以每个中文片段拆成 整段 + 二字组 + 三字组，一次调用全部丢给它去或匹配；
 * 命中的词越多分数越高，正文里真正的设备名自然排在前面。
 * 数字/字母段（F009、16MPa）原样保留。单字词噪音大，除非整句只有一个字否则丢弃。
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
): string {
  const safeTitle = title.replace(/"/g, '\\"')
  // 原件留在服务器上（data/inbox），页面里登记文件名，检索时能顺藤摸到原件
  const origin = originName ? `\n---\n\n> **原件**：${originName}（kb-web 上传，原件保存在服务器 data/inbox/）\n` : ''
  return `---\ntitle: "${safeTitle}"\ntype: note\ntags:\n  - ${field}\n  - ${sensitivity}\n---\n\n${body.trim()}\n${origin}`
}

/**
 * 判「告知/陈述」而不是「提问」：没有问号、没有疑问词、长度够 → 不查库，只回确认。
 * questionWords 放 config.yaml（可按项目加词），改词不用改代码。
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
  return n.length >= 4
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
