/** 从请求头取 Bearer。外部 agent 只认网页下发的个人钥匙。 */
export function bearerOf(header: string | undefined): string | null {
  if (!header) return null
  const m = /^Bearer\s+(.+)$/i.exec(header.trim())
  return m ? m[1].trim() : null
}
