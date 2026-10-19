/**
 * Hermes（小A）对话客户端。
 * 走 Hermes 网关的 OpenAI 兼容接口（默认本机 127.0.0.1:8377，model=agv）。
 * 密钥只放 server/.env：HERMES_API_URL / HERMES_API_KEY / HERMES_MODEL / HERMES_TIMEOUT_MS
 * 规则：这里只做"把话发给小A、把小A的字拿回来"，不做检索、不碰数据库。
 */

export type HermesPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } }

export interface HermesTurn {
  role: 'user' | 'assistant'
  /** 纯文本，或多模态分段（截图提问时用） */
  content: string | HermesPart[]
}

export function hermesConfigured(): boolean {
  return Boolean(process.env.HERMES_API_KEY)
}

const baseUrl = () => (process.env.HERMES_API_URL || 'http://127.0.0.1:8377').replace(/\/+$/, '')
const modelName = () => process.env.HERMES_MODEL || 'agv'
const timeoutMs = () => Number(process.env.HERMES_TIMEOUT_MS || 180000)

export interface StreamHandlers {
  /** 每收到一段增量文本回调一次 */
  onDelta?: (text: string) => void
}

/**
 * 流式问小A（SSE 解析 OpenAI 兼容 delta）。
 * 返回完整回答；HTTP/网络错误抛 Error，由调用方决定怎么回前端。
 */
export async function askHermesStream(turns: HermesTurn[], handlers: StreamHandlers = {}): Promise<string> {
  if (!hermesConfigured()) throw new Error('未配置 HERMES_API_KEY（见 server/.env.example）')

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs())
  try {
    const res = await fetch(`${baseUrl()}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${process.env.HERMES_API_KEY}`,
      },
      body: JSON.stringify({ model: modelName(), messages: turns, stream: true }),
      signal: controller.signal,
    })
    if (!res.ok || !res.body) {
      const detail = await res.text().catch(() => '')
      throw new Error(`Hermes 返回 ${res.status}：${detail.slice(0, 300)}`)
    }

    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    let full = ''

    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      let cut: number
      while ((cut = buffer.indexOf('\n\n')) >= 0) {
        const frame = buffer.slice(0, cut)
        buffer = buffer.slice(cut + 2)
        for (const line of frame.split('\n')) {
          const trimmed = line.trim()
          if (!trimmed.startsWith('data:')) continue
          const payload = trimmed.slice(5).trim()
          if (!payload || payload === '[DONE]') continue
          try {
            const json = JSON.parse(payload)
            const delta: string = json?.choices?.[0]?.delta?.content ?? ''
            if (delta) {
              full += delta
              handlers.onDelta?.(delta)
            }
          } catch {
            // 忽略非 JSON 心跳帧
          }
        }
      }
    }
    return full
  } finally {
    clearTimeout(timer)
  }
}
