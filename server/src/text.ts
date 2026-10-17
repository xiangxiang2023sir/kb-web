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

export function asciiSlug(title: string, id: string): string {
  const ascii = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40)
  return `${ascii || 'doc'}-${id.slice(-6)}`
}

export function toMarkdown(title: string, field: Field, sensitivity: Sensitivity, body: string): string {
  const safeTitle = title.replace(/"/g, '\\"')
  return `---\ntitle: "${safeTitle}"\ntype: note\ntags:\n  - ${field}\n  - ${sensitivity}\n---\n\n${body.trim()}\n`
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
  if (ext === '.xlsx' || ext === '.xls') {
    const xlsx = await import('xlsx')
    const book = xlsx.readFile(filePath)
    return book.SheetNames.map((name) => xlsx.utils.sheet_to_csv(book.Sheets[name])).join('\n')
  }
  throw Object.assign(new Error('只支持 pdf、docx、xlsx、md、txt'), { status: 400 })
}

const WIKI = /\[\[([^\]|#]+)(?:#[^\]|]+)?(?:\|[^\]]+)?\]\]/g
const KB = /kb:\/\/([A-Za-z0-9._/-]+)/g

export function linkedSlugs(markdown: string): string[] {
  const found = new Set<string>()
  for (const match of markdown.matchAll(WIKI)) found.add(match[1].trim())
  for (const match of markdown.matchAll(KB)) found.add(match[1].trim())
  return [...found]
}
