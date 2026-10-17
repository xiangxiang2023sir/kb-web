import type { Field, Sensitivity, User } from './config.js'

const SLUG = /^(electrical|dispatch|mechanical)\/(public|internal|confidential|top_secret)\/.+/

export interface ParsedSlug {
  field: Field
  sensitivity: Sensitivity
  slug: string
}

/** 入库约定：{领域}/{密级}/{短名}。对不上的结果一律不返回，避免把未分级页面漏给用户。 */
export function parseSlug(slug: string): ParsedSlug | null {
  if (!SLUG.test(slug)) return null
  const [field, sensitivity] = slug.split('/')
  return { field: field as Field, sensitivity: sensitivity as Sensitivity, slug }
}

export function canSee(user: User, field: Field, sensitivity: Sensitivity): boolean {
  if (sensitivity === 'top_secret' && user.role !== 'owner') return false
  if (user.role === 'guest') return sensitivity === 'public'
  if (user.role === 'operator') return user.field === field
  return true
}

export function assertCanConfirm(user: User, sensitivity: Sensitivity) {
  if (sensitivity === 'top_secret' && user.role !== 'owner') {
    const err = new Error('只有主人可以把文档定为绝密') as Error & { status?: number }
    err.status = 403
    throw err
  }
}
