/**
 * REST API 清单（前缀 /api，HttpOnly Cookie 鉴权）。
 * 后端按此清单实现，前端页面只调用这里的方法。
 * 问答流不走 REST，走 src/api/ws.ts（/ws WebSocket 推流）。
 *
 * 后端实现参考（详见 AGENTS.md）：
 * - /ws ask           → 闲聊或 gbrain search → DeepSeek 流式生成
 * - /feishu/events    → 飞书 webhook（经验「记一下」；问答走外部智能体，原样转发 /api/agent/ask）
 * - /admin/docs/*     → extractText 解析 → 分类 → gbrain capture 入库
 * - /admin/health/run → gbrain orphans 等
 */
import { http } from './http'
import type {
  AdminOverview,
  ChatArchive,
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
  /** 注册申请：提交后是 pending，管理员批准后才能登录 */
  register: (payload: { employeeNo: string; name: string; password: string; title: string; department?: string; note?: string }) =>
    http
      .post<{ ok: boolean; status: string; message: string }>('/auth/register', payload)
      .then((r) => r.data),
  logout: () => http.post('/auth/logout'),
  me: () => http.get<User>('/auth/me').then((r) => r.data),
}

// ---------- 会话 ----------
export const chatApi = {
  sessions: () => http.get<Session[]>('/chat/sessions').then((r) => r.data),
  session: (sessionId: string) => http.get<Session>(`/chat/sessions/${sessionId}`).then((r) => r.data),
  messages: (sessionId: string) =>
    http.get<SessionMessage[]>(`/chat/sessions/${sessionId}/messages`).then((r) => r.data),
  deleteSession: (sessionId: string) =>
    http.delete(`/chat/sessions/${sessionId}`).then((r) => r.data),
  /**
   * 上传聊天照片：先存到 Node 后端，返回附件引用；
   * 提问时随 /ws ask 消息带上，后端取照片交给 Hermes 做视觉分析
   */
  uploadImage: (file: File) => {
    const form = new FormData()
    form.append('file', file)
    return http.post<ChatAttachment>('/chat/uploads', form).then((r) => r.data)
  },
  /** 把一轮对话沉淀成「待确认」文档（管理员确认后才入库） */
  saveToKb: (payload: {
    question: string
    answer: string
    sessionId?: string
    citations?: { title: string }[]
  }) =>
    http
      .post<{ ok: boolean; id?: string; duplicate?: boolean }>('/chat/save-to-kb', payload)
      .then((r) => r.data),
  saveSelected: (payload: { sessionId: string; messageIds: string[] }) =>
    http
      .post<{ ok: boolean; id?: string; duplicate?: boolean }>('/chat/save-selected', payload)
      .then((r) => r.data),
  archives: () => http.get<ChatArchive[]>('/chat/archives').then((r) => r.data),
  archive: (userId: string, weekKey: string) =>
    http.get<{ markdown: string; title: string }>(`/chat/archives/${userId}/${weekKey}`).then((r) => r.data),
  archiveToPending: (userId: string, weekKey: string) =>
    http
      .post<{ ok: boolean; id?: string; duplicate?: boolean; title?: string }>(
        `/chat/archives/${userId}/${weekKey}/to-pending`,
      )
      .then((r) => r.data),
  runArchives: () =>
    http.post<{ ok: boolean; weekKey: string; files: number }>('/chat/archives/run').then((r) => r.data),
  /** 当前这把外部钥匙是何时生成的（没有则 createdAt 为空） */
  skillMeta: () => http.get<{ createdAt: string | null }>('/agent-skill').then((r) => r.data),
  /** 下载 Skill：生成新钥匙，旧文件立刻作废 */
  downloadSkill: () =>
    http.post<{ filename: string; markdown: string; createdAt: string }>('/agent-skill').then((r) => r.data),
  /** 作废当前钥匙 */
  revokeSkill: () => http.delete('/agent-skill').then((r) => r.data),
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
  confirmDoc: (id: string, field: Field, sensitivity: Sensitivity, project?: string | null) =>
    http.post(`/admin/docs/${id}/confirm`, { field, sensitivity, project: project ?? null }),
  rejectDoc: (id: string, reason: string) => http.post(`/admin/docs/${id}/reject`, { reason }),

  healthIssues: () => http.get<HealthIssue[]>('/admin/health/issues').then((r) => r.data),
  /** 触发一次全量检查：死链、引用完整性、格式规范 */
  runHealth: () => http.post('/admin/health/run'),

  questions: (params: { field?: Field; status?: QuestionStatus }) =>
    http.get<QuestionItem[]>('/admin/questions', { params }).then((r) => r.data),
  question: (id: string) => http.get<QuestionDetail>(`/admin/questions/${id}`).then((r) => r.data),
  assignQuestion: (id: string, userId: string) => http.post(`/admin/questions/${id}/assign`, { userId }),
  deleteQuestion: (id: string) => http.delete(`/admin/questions/${id}`),
  /** 解答后入库：Hermes 自动分类，随后进入待确认队列 */
  resolveQuestion: (
    id: string,
    payload: { answer: string; title: string; field: Field; sensitivity: Sensitivity },
  ) => http.post(`/admin/questions/${id}/resolve`, payload),

  users: () => http.get<User[]>('/admin/users').then((r) => r.data),
  /** 注册申请待批准 */
  pendingUsers: () =>
    http
      .get<
        { id: string; name: string; title: string | null; department: string | null; appliedAt: string | null; note: string | null }[]
      >('/admin/users/pending')
      .then((r) => r.data),
  approveUser: (id: string, role: Role, field: Field | null) =>
    http.post(`/admin/users/${id}/approve`, { role, field }).then((r) => r.data),
  rejectUser: (id: string) => http.post(`/admin/users/${id}/reject`).then((r) => r.data),
  createUser: (payload: { employeeNo?: string; name: string; password: string; role: Role; field: Field | null }) =>
    http.post('/admin/users', payload),
  updateUser: (id: string, payload: { employeeNo?: string; role?: Role; field?: Field | null }) =>
    http.patch(`/admin/users/${id}`, payload),
  deleteUser: (id: string) => http.delete(`/admin/users/${id}`).then((r) => r.data),
}

// ---------- 找小A（Hermes 网关，管理端） ----------
export interface AssistantTurn {
  role: 'user' | 'assistant'
  content: string
}

export const assistantApi = {
  /**
   * 流式对话：POST /api/admin/assistant/chat（SSE）。
   * 每收到一段增量文本回调 onDelta，返回完整回答。用 fetch 读流（axios 不支持）。
   */
  async chat(
    turns: AssistantTurn[],
    onDelta: (text: string) => void,
    signal?: AbortSignal,
    images: string[] = [],
  ): Promise<string> {
    const base = import.meta.env.VITE_API_BASE || '/api'
    const res = await fetch(`${base}/admin/assistant/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ messages: turns, images }),
      signal,
    })
    if (!res.ok) {
      const detail = await res.text().catch(() => '')
      throw new Error(`HTTP ${res.status} ${detail.slice(0, 200)}`)
    }
    if (!res.body) throw new Error('当前浏览器不支持流式读取')

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
        let event = 'message'
        let data = ''
        for (const line of frame.split('\n')) {
          if (line.startsWith('event:')) event = line.slice(6).trim()
          else if (line.startsWith('data:')) data += line.slice(5).trim()
        }
        if (!data) continue
        const json = JSON.parse(data)
        if (event === 'delta' && json.text) {
          full += json.text
          onDelta(json.text)
        } else if (event === 'done') {
          full = json.text ?? full
        } else if (event === 'error') {
          throw new Error(json.message || '小A 出错了')
        }
      }
    }
    return full
  },
}

export interface KbPageItem {
  slug: string
  title: string
  type: string
  updatedAt: string | null
  field: string
  sensitivity: string
}
export interface KbStatus {
  stats: {
    pageCount: number
    chunkCount: number
    embeddedCount: number
    linkCount: number
    tagCount: number
    timelineCount: number
    byType: Record<string, number>
  }
  total: number
  byField: Record<string, number>
  bySensitivity: Record<string, number>
  malformedSlugs: number
  recent: { slug: string; title: string; updatedAt: string | null }[]
}

/** 资料库（以 GBrain 为准） */
export const kbApi = {
  status: () => http.get<KbStatus>('/admin/kb/status').then((r) => r.data),
  pages: (params: { keyword?: string; field?: string; sensitivity?: string; project?: string; page?: number; size?: number }) =>
    http
      .get<{ total: number; page: number; size: number; list: KbPageItem[] }>('/admin/kb/pages', { params })
      .then((r) => r.data),
  page: (slug: string, sourceId?: string) =>
    http
      .get<{ slug: string; content: string }>('/admin/kb/page', { params: { slug, sourceId } })
      .then((r) => r.data),
  remove: (slug: string, sourceId?: string) =>
    http
      .delete<{ ok: boolean; slug: string; cleanedDocs: number }>('/admin/kb/page', { params: { slug, sourceId } })
      .then((r) => r.data),
}

export interface ProjectItem {
  id: string
  name: string
  status: string
  note: string | null
  createdAt: string
  kbSource?: string
  sourceReady?: boolean | null
  memberCount?: number
  leads?: string[]
}
export interface ProjectMember {
  userId: string
  name: string
  role: string
  addedAt: string
}

/** 项目与成员 */
export const projectsApi = {
  list: () => http.get<ProjectItem[]>('/admin/projects').then((r) => r.data),
  create: (payload: { id: string; name: string; note?: string; ownSource?: boolean; attach?: 'tools' | 'default' }) =>
    http
      .post<{ ok: boolean; id: string; kbSource?: string; sourceReady?: boolean; warning?: string }>(
        '/admin/projects',
        payload,
      )
      .then((r) => r.data),
  ensureSource: (id: string) =>
    http.post<{ ok: boolean; status: string }>(`/admin/projects/${id}/ensure-source`).then((r) => r.data),
  update: (id: string, patch: { name?: string; status?: string; note?: string | null }) =>
    http.patch(`/admin/projects/${id}`, patch).then((r) => r.data),
  members: (id: string) => http.get<ProjectMember[]>(`/admin/projects/${id}/members`).then((r) => r.data),
  addMember: (id: string, userId: string, role: 'lead' | 'member') =>
    http.post(`/admin/projects/${id}/members`, { userId, role }).then((r) => r.data),
  removeMember: (id: string, userId: string) =>
    http.delete(`/admin/projects/${id}/members/${userId}`).then((r) => r.data),
  mine: () =>
    http
      .get<{ id: string; name: string; role: string | null; kbSource?: string; sourceReady?: boolean | null }[]>(
        '/projects/mine',
      )
      .then((r) => r.data),
}

/** 对话里「入库 xxx」：先整理，用户确认后再提交 */
export interface IntakeDraft {
  title: string
  content: string
  field: string
  sensitivity: string
  project: string | null
}
export const intakeApi = {
  prepare: (raw: string) =>
    http
      .post<{ ok: boolean; draft: IntakeDraft; similar: { slug: string; title: string }[] }>(
        '/chat/prepare-intake',
        { raw },
      )
      .then((r) => r.data),
  save: (payload: { title: string; content: string; field: string; sensitivity: string; project?: string | null; sessionId?: string }) =>
    http.post('/chat/save-to-kb', payload).then((r) => r.data),
}
