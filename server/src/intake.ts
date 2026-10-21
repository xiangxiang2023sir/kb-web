import type { AppConfig } from './config.js'
import { streamAnswer } from './llm.js'

export interface IntakeDraft {
  title: string
  content: string
  field: string | null
  sensitivity: string | null
  project: string | null
}

const PROMPT = `你是工厂知识库的入库整理助手。用户会把一段口述/粘贴的内容交给你，你要整理成能直接入库的一条经验。

硬规矩：
1. 只整理，不改意思。数字、型号、参数、报错码、地址一律原样保留，不许换算、不许补充。
2. 不确定的就写「资料未给出」，绝不编造步骤或参数。
3. 正文用四段小标题，缺哪段就写「（未提及）」：
   ## 适用前提
   ## 现象
   ## 结论/做法
   ## 证据
4. 标题 ≤ 30 字，一句话说清是什么问题/结论，不要「关于……」这种空话。
5. 四段合计 100~400 字，能短不长。

另外给两个字段（只能从给定候选里选，拿不准就留空）：
- field：electrical（电气/电机/雷达/电池/安全/图纸）、dispatch（调度/M4/RCS/导航/任务）、mechanical（机械/传动/结构/装配）
- sensitivity：public（可对外）、internal（内部）、confidential（手册图纸类）

只输出 JSON，不要代码块、不要解释：
{"title":"...","content":"## 适用前提\\n...","field":"electrical","sensitivity":"internal"}`

/** 把口述内容整理成一条可入库的经验（只整理，不落库） */
export async function prepareIntake(
  config: AppConfig,
  raw: string,
  hint: { field?: string | null; sensitivity?: string | null } = {},
): Promise<IntakeDraft> {
  const text = raw.trim()
  const fallback: IntakeDraft = {
    title: text.split('\n')[0].replace(/^#+\s*/, '').slice(0, 30) || '未命名经验',
    content: text,
    field: hint.field ?? null,
    sensitivity: hint.sensitivity ?? null,
    project: null,
  }
  if (text.length < 6) return fallback

  const messages: { role: 'system' | 'user' | 'assistant'; content: string }[] = [
    { role: 'system', content: PROMPT },
    {
      role: 'user',
      content: `候选 field 默认：${hint.field ?? '（自行判断）'}；候选 sensitivity 默认：${hint.sensitivity ?? 'internal'}\n\n原始内容：\n${text.slice(0, 6000)}`,
    },
  ]
  let out = ''
  const controller = new AbortController()
  try {
    await streamAnswer(config, messages, (d) => {
      out += d
    }, controller.signal)
  } catch {
    return fallback
  }
  const jsonText = out.trim().replace(/^```(?:json)?\s*/i, '').replace(/```$/i, '')
  const start = jsonText.indexOf('{')
  const end = jsonText.lastIndexOf('}')
  if (start < 0 || end <= start) return fallback
  try {
    const parsed = JSON.parse(jsonText.slice(start, end + 1)) as {
      title?: string
      content?: string
      field?: string
      sensitivity?: string
    }
    const title = String(parsed.title ?? '').trim().slice(0, 60) || fallback.title
    const body = String(parsed.content ?? '').trim()
    if (!body) return fallback
    return {
      title,
      // 原始表述永远附在末尾：事后能对照"总结有没有漏"
      content: `${body}\n\n---\n\n### 原始表述\n\n${text}`,
      field: parsed.field ?? hint.field ?? null,
      sensitivity: parsed.sensitivity ?? hint.sensitivity ?? 'internal',
      project: null,
    }
  } catch {
    return fallback
  }
}
