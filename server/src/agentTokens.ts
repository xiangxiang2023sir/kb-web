/**
 * 请求头里的 Bearer。全局 AGENT_TOKENS 已停用，外部 agent 只认网页下发的个人钥匙。
 */
export interface AgentToken {
  name: string
  token: string
}

export function parseAgentTokens(raw: string | undefined): AgentToken[] {
  if (!raw) return []
  return raw
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => {
      const idx = item.indexOf(':')
      if (idx <= 0) return null
      const name = item.slice(0, idx).trim()
      const token = item.slice(idx + 1).trim()
      return name && token ? { name, token } : null
    })
    .filter((x): x is AgentToken => x !== null)
}

/** 从请求头取 Bearer token */
export function bearerOf(header: string | undefined): string | null {
  if (!header) return null
  const m = /^Bearer\s+(.+)$/i.exec(header.trim())
  return m ? m[1].trim() : null
}

/** token → agent 名；不认识返回 null */
export function agentNameOf(tokens: AgentToken[], token: string | null): string | null {
  if (!token) return null
  const hit = tokens.find((t) => t.token === token)
  return hit ? hit.name : null
}
