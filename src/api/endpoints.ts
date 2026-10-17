/**
 * REST API 清单（前缀 /api，HttpOnly Cookie 鉴权）。
 * 后端按此清单实现，前端页面只调用这里的方法。
 * 问答流不走 REST，走 src/api/ws.ts（/ws WebSocket 推流）。
 *
 * 后端实现参考（Node → GBrain CLI 子进程 / Hermes HTTP）：
 * - /ws ask           → gbrain search/query 检索 → Hermes 生成（流式）
 * - /admin/docs/*     → 上传解析 → Hermes 自动分类 → gbrain put 入库
 * - /admin/health/run → gbrain find_orphans / find_anomalies 等
 */
import { http } from './http'
import type {
  AdminOverview,
  ChatAttachment,
  DocDetail,
  DocItem,
  DocStatus,
  Field,
  HealthIssue,
  QuestionDetail,
  QuestionItem,
  QuestionStatus,
  Role,
  Sensitivity,
  Session,
  SessionMessage,
  UploadResult,
  User,
} from '@/types'

// ---------- 认证 ----------
export const authApi = {
  login: (username: string, password: string) =>
    http.post<User>('/auth/login', { username, password }).then((r) => r.data),
  /** 游客进入：签发一个只能检索公开知识的会话 */
  guest: () => http.post<User>('/auth/guest').then((r) => r.data),
  logout: () => http.post('/auth/logout'),
  me: () => http.get<User>('/auth/me').then((r) => r.data),
}

// ---------- 会话 ----------
export const chatApi = {
  sessions: () => http.get<Session[]>('/chat/sessions').then((r) => r.data),
  messages: (sessionId: string) =>
    http.get<SessionMessage[]>(`/chat/sessions/${sessionId}/messages`).then((r) => r.data),
  /**
   * 上传聊天照片：先存到 Node 后端，返回附件引用；
   * 提问时随 /ws ask 消息带上，后端取照片交给 Hermes 做视觉分析
   */
  uploadImage: (file: File) => {
    const form = new FormData()
    form.append('file', file)
    return http.post<ChatAttachment>('/chat/uploads', form).then((r) => r.data)
  },
}

// ---------- 问题队列（用户侧） ----------
export const questionApi = {
  /** 把 AI 答不了的问题转入队列，由系统按领域通知责任人 */
  submit: (question: string, sessionId?: string) =>
    http.post<{ id: string }>('/questions', { question, sessionId }).then((r) => r.data),
  mine: () => http.get<QuestionItem[]>('/questions/mine').then((r) => r.data),
}

// ---------- 管理端 ----------
export interface DocQuery {
  keyword?: string
  field?: Field
  sensitivity?: Sensitivity
  status?: DocStatus
  page?: number
  size?: number
}

export const adminApi = {
  overview: () => http.get<AdminOverview>('/admin/overview').then((r) => r.data),

  docs: (params: DocQuery) =>
    http.get<{ list: DocItem[]; total: number }>('/admin/docs', { params }).then((r) => r.data),
  doc: (id: string) => http.get<DocDetail>(`/admin/docs/${id}`).then((r) => r.data),
  /** 上传后由 Hermes 自动分类，返回建议的领域与密级；文档先进待确认队列 */
  upload: (file: File) => {
    const form = new FormData()
    form.append('file', file)
    return http.post<UploadResult>('/admin/docs/upload', form).then((r) => r.data)
  },
  /** 人工确认后才真正写入 GBrain */
  confirmDoc: (id: string, field: Field, sensitivity: Sensitivity) =>
    http.post(`/admin/docs/${id}/confirm`, { field, sensitivity }),
  rejectDoc: (id: string, reason: string) => http.post(`/admin/docs/${id}/reject`, { reason }),

  healthIssues: () => http.get<HealthIssue[]>('/admin/health/issues').then((r) => r.data),
  /** 触发一次全量检查：死链、引用完整性、格式规范 */
  runHealth: () => http.post('/admin/health/run'),

  questions: (params: { field?: Field; status?: QuestionStatus }) =>
    http.get<QuestionItem[]>('/admin/questions', { params }).then((r) => r.data),
  question: (id: string) => http.get<QuestionDetail>(`/admin/questions/${id}`).then((r) => r.data),
  assignQuestion: (id: string, userId: string) => http.post(`/admin/questions/${id}/assign`, { userId }),
  /** 解答后入库：Hermes 自动分类，随后进入待确认队列 */
  resolveQuestion: (
    id: string,
    payload: { answer: string; title: string; field: Field; sensitivity: Sensitivity },
  ) => http.post(`/admin/questions/${id}/resolve`, payload),

  users: () => http.get<User[]>('/admin/users').then((r) => r.data),
  createUser: (payload: { name: string; password: string; role: Role; field: Field | null }) =>
    http.post('/admin/users', payload),
  updateUser: (id: string, payload: { role?: Role; field?: Field | null }) =>
    http.patch(`/admin/users/${id}`, payload),
}
