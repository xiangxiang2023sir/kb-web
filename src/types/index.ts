/**
 * 全局类型定义。
 * 这里同时是与 Node 后端约定的接口协议：
 * - REST 走 /api（HttpOnly Cookie 鉴权），见 src/api/endpoints.ts
 * - 问答流走 /ws（WebSocket），一条长连接反复提问，消息里带 questionId 区分
 * 后端在 GBrain（知识库）与 Hermes（生成/入库）之上按此结构封装即可。
 */

// ---------- 用户与权限 ----------

/** 角色：主人 > 管理员 > 操作员 > 游客 */
export type Role = 'owner' | 'admin' | 'operator' | 'guest'

/** 业务领域：操作员只能看自己领域的知识 */
export type Field = 'electrical' | 'dispatch' | 'mechanical'

/** 密级：top_secret 仅主人可见，检索时由后端过滤 */
export type Sensitivity = 'public' | 'internal' | 'confidential' | 'top_secret'

export interface User {
  id: string
  name: string
  role: Role
  /** 操作员所属领域；管理员/主人为 null（可见全部领域） */
  field: Field | null
}

// ---------- 问答 WebSocket 协议 ----------

export type ConfidenceLevel = 'high' | 'medium' | 'low'

/** 引用出处。citation 事件携带；若正文含 [n] 标记，由 marker 对应 */
export interface Citation {
  id: string
  title: string
  path: string
  snippet: string
  field: Field
  sensitivity: Sensitivity
  /** 可选：正文中的引用标记，如 "[1]" */
  marker?: string
}

/** 聊天图片附件：先走 REST 上传（POST /chat/uploads），再在 ask 消息里引用 */
export interface ChatAttachment {
  id: string
  /** 图片访问地址（GET /chat/uploads/:id） */
  url: string
  name: string
  mimeType: string
  size: number
}

/** 前端 → 后端 */
export type WsClientMessage =
  | { type: 'ask'; questionId: string; question: string; sessionId?: string; attachments?: ChatAttachment[] }
  | { type: 'cancel'; questionId: string }
  /** 心跳：前端每 25s 发一次，后端应立即回 pong */
  | { type: 'ping' }

/** 检索/生成阶段；no_evidence 表示知识库依据不足 */
export type WsPhase = 'retrieving' | 'generating' | 'no_evidence'

/** 后端 → 前端 */
export type WsServerMessage =
  | { type: 'status'; questionId: string; phase: WsPhase }
  | { type: 'delta'; questionId: string; text: string }
  | { type: 'citation'; questionId: string; citation: Citation }
  | { type: 'confidence'; questionId: string; level: ConfidenceLevel; score: number }
  | { type: 'done'; questionId: string }
  | { type: 'error'; questionId?: string; message: string }
  /** 新会话的 id。前端记下后，同一页的追问会带上 sessionId */
  | { type: 'session'; questionId: string; sessionId: string }
  /** 心跳应答 */
  | { type: 'pong' }

// ---------- 会话 ----------

export interface Session {
  id: string
  title: string
  updatedAt: string
  preview?: string
}

/** 历史会话里的消息记录（GET /chat/sessions/:id/messages 返回） */
export interface SessionMessage {
  id: string
  role: 'user' | 'assistant'
  text: string
  citations: Citation[]
  /** 用户消息携带的照片附件 */
  attachments?: ChatAttachment[]
  confidence?: { level: ConfidenceLevel; score: number }
  createdAt: string
}

// ---------- 知识文档 ----------

/** 文档状态机：待确认 → 已入库 / 已驳回 */
export type DocStatus = 'pending' | 'confirmed' | 'rejected'

export interface DocItem {
  id: string
  title: string
  field: Field
  sensitivity: Sensitivity
  status: DocStatus
  updatedAt: string
  /** Hermes 自动分类的建议值（待确认文档才有） */
  suggestedField?: Field
  suggestedSensitivity?: Sensitivity
}

export interface DocDetail extends DocItem {
  content: string
  referencedBy: { sessionId: string; question: string; askedAt: string }[]
  /** 服务器上是否留存了上传原件（可下载核对） */
  hasOriginal?: boolean
}

export interface UploadResult {
  id: string
  title: string
  suggestedField: Field
  suggestedSensitivity: Sensitivity
}

// ---------- 健康检查 ----------

export type HealthIssueType = 'dead_link' | 'orphan_reference' | 'format'

export interface HealthIssue {
  id: string
  type: HealthIssueType
  docId: string
  docTitle: string
  detail: string
}

// ---------- 问题队列 ----------

export type QuestionStatus = 'open' | 'assigned' | 'resolved'

export interface QuestionItem {
  id: string
  question: string
  askedBy: string
  field: Field
  status: QuestionStatus
  assignee?: string
  createdAt: string
}

export interface QuestionDetail extends QuestionItem {
  sessionId?: string
  /** 提问时的对话上下文，方便责任人理解问题 */
  context?: string
}

// ---------- 管理总览 ----------

export interface AdminOverview {
  pendingDocs: number
  unassignedQuestions: number
  failedChecks: number
  todayQuestions: number
}
