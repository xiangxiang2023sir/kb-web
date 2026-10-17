import type { AppConfig, Field, Sensitivity } from './config.js'
import { isField, isSensitivity } from './config.js'

export class LlmError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'LlmError'
  }
}

interface ChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string | unknown[]
}

function apiKey(kind: 'text' | 'vision'): string {
  if (kind === 'vision' && process.env.VISION_API_KEY) return process.env.VISION_API_KEY
  return process.env.DEEPSEEK_API_KEY ?? ''
}

async function postChat(baseUrl: string, key: string, body: unknown, signal?: AbortSignal): Promise<Response> {
  if (!key) throw new LlmError('未配置 DEEPSEEK_API_KEY，请写入 server/.env 后重启')
  let res: Response
  try {
    res = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal,
    })
  } catch (err) {
    if ((err as Error).name === 'AbortError') throw err
    throw new LlmError(`模型接口连不上：${(err as Error).message}`)
  }
  if (!res.ok) {
    const detail = await res.text().catch(() => '')
    throw new LlmError(`模型接口返回 ${res.status}${detail ? `：${detail.slice(0, 200)}` : ''}`)
  }
  return res
}

export async function streamAnswer(
  config: AppConfig,
  messages: ChatMessage[],
  onDelta: (text: string) => void,
  signal: AbortSignal,
) {
  const res = await postChat(
    config.llm.baseUrl,
    apiKey('text'),
    {
      model: config.llm.model,
      temperature: config.llm.temperature,
      max_tokens: config.llm.maxTokens,
      stream: true,
      messages,
    },
    signal,
  )
  if (!res.body) throw new LlmError('模型没有返回内容')
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buf = ''
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buf += decoder.decode(value, { stream: true })
    const lines = buf.split('\n')
    buf = lines.pop() ?? ''
    for (const line of lines) {
      const trimmed = line.trim()
      if (!trimmed.startsWith('data:')) continue
      const data = trimmed.slice(5).trim()
      if (!data || data === '[DONE]') continue
      try {
        const json = JSON.parse(data) as { choices?: { delta?: { content?: string } }[] }
        const text = json.choices?.[0]?.delta?.content
        if (text) onDelta(text)
      } catch {
        // 忽略半截的 SSE 行
      }
    }
  }
}

export async function describeImages(config: AppConfig, images: { mime: string; data: Buffer }[], signal: AbortSignal): Promise<string> {
  if (!config.vision.baseUrl || !config.vision.model) {
    throw new LlmError('视觉模型未配置。在 config.yaml 填写 vision.baseUrl 和 vision.model 后再发送照片')
  }
  const key = apiKey('vision')
  const content: unknown[] = [{ type: 'text', text: config.prompts.vision }]
  for (const image of images) {
    content.push({
      type: 'image_url',
      image_url: { url: `data:${image.mime};base64,${image.data.toString('base64')}` },
    })
  }
  const res = await postChat(
    config.vision.baseUrl,
    key,
    { model: config.vision.model, temperature: 0.2, max_tokens: 800, messages: [{ role: 'user', content }] },
    signal,
  )
  const json = (await res.json()) as { choices?: { message?: { content?: string } }[] }
  return json.choices?.[0]?.message?.content?.trim() || '照片里没有识别出可用文字'
}

export async function classifyText(config: AppConfig, text: string): Promise<{ field: Field; sensitivity: Sensitivity } | null> {
  if (!process.env.DEEPSEEK_API_KEY) return null
  try {
    const res = await postChat(config.llm.baseUrl, apiKey('text'), {
      model: config.llm.model,
      temperature: 0,
      max_tokens: 200,
      messages: [
        { role: 'system', content: config.prompts.classify },
        { role: 'user', content: text.slice(0, config.limits.classifyChars) },
      ],
    })
    const json = (await res.json()) as { choices?: { message?: { content?: string } }[] }
    const raw = json.choices?.[0]?.message?.content ?? ''
    const start = raw.indexOf('{')
    const end = raw.lastIndexOf('}')
    if (start < 0 || end < start) return null
    const parsed = JSON.parse(raw.slice(start, end + 1)) as { field?: unknown; sensitivity?: unknown }
    if (!isField(parsed.field) || !isSensitivity(parsed.sensitivity)) return null
    return { field: parsed.field, sensitivity: parsed.sensitivity }
  } catch {
    return null
  }
}
