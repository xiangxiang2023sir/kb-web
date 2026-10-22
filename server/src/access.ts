import type { Field, Role, Sensitivity, User } from './config.js'

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

export type ProjectRole = 'lead' | 'member'

/**
 * 项目内的密级可见性：
 * 非成员 → 仅 public；成员 → public/internal；项目负责人 → +confidential；系统主人 → 全部
 */
export function canSeeInProject(
  systemRole: Role,
  projectRole: ProjectRole | null,
  sensitivity: Sensitivity,
): boolean {
  if (systemRole === 'owner') return true
  if (!projectRole) return sensitivity === 'public'
  if (projectRole === 'member') return sensitivity === 'public' || sensitivity === 'internal'
  return sensitivity === 'public' || sensitivity === 'internal' || sensitivity === 'confidential'
}

/**
 * 选了项目就用项目角色。没选时：项目分区用该分区里的角色，公共库 default 用领域规则。
 * shortcut: 命中没有 source_id 时按领域判断，检索结果都带来源后再按项目角色收紧。
 */
export function pageVisible(
  user: User,
  field: Field,
  sensitivity: Sensitivity,
  opts: {
    projectRole?: ProjectRole | null
    sourceId?: string
    sourceRoles?: ReadonlyMap<string, ProjectRole>
  },
): boolean {
  const role =
    opts.projectRole !== undefined
      ? opts.projectRole
      : opts.sourceId && opts.sourceId !== 'default'
        ? (opts.sourceRoles?.get(opts.sourceId) ?? null)
        : undefined
  if (role === undefined) return canSee(user, field, sensitivity)
  return canSeeInProject(user.role, role, sensitivity)
}
