import type {
  DocStatus,
  Field,
  HealthIssueType,
  QuestionStatus,
  Role,
  Sensitivity,
} from '@/types'

/** 各类枚举的中文标签，全局统一 */
export const roleLabels: Record<Role, string> = {
  owner: '主人',
  admin: '管理员',
  operator: '操作员',
  guest: '游客',
}

export const fieldLabels: Record<Field, string> = {
  electrical: '电气',
  dispatch: '调度',
  mechanical: '机械',
}

export const sensitivityLabels: Record<Sensitivity, string> = {
  public: '公开',
  internal: '内部',
  confidential: '机密',
  top_secret: '绝密',
}

export const docStatusLabels: Record<DocStatus, string> = {
  pending: '待确认',
  confirmed: '已入库',
  rejected: '已驳回',
}

export const questionStatusLabels: Record<QuestionStatus, string> = {
  open: '待分配',
  assigned: '处理中',
  resolved: '已解决',
}

export const healthTypeLabels: Record<HealthIssueType, string> = {
  dead_link: '死链',
  orphan_reference: '引用缺失',
  format: '格式问题',
}

export function formatTime(iso: string): string {
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString('zh-CN', { hour12: false })
}
