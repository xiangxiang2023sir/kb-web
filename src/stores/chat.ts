import { defineStore } from 'pinia'
import { ElMessage } from 'element-plus'
import { wsClient } from '@/api/ws'
import { chatApi, questionApi } from '@/api/endpoints'
import type { ChatAttachment, Citation, ConfidenceLevel, Session, WsServerMessage } from '@/types'

export type MessagePhase = 'retrieving' | 'generating' | 'done' | 'no_evidence' | 'acknowledged' | 'error'

export interface ChatMessage {
  id: string
  role: 'user' | 'assistant'
  text: string
  citations: Citation[]
  /** 用户消息携带的照片 */
  attachments?: ChatAttachment[]
  confidence?: { level: ConfidenceLevel; score: number }
  phase: MessagePhase
  errorText?: string
  /** 检索阶段被告知依据不足（用于结束后提示转入问题队列） */
  noEvidence?: boolean
  submittedToQueue?: boolean
  /** 这条回答已提交入库（待确认） */
  savedToKb?: boolean
  /** 这条是「告知」而不是提问：没查库，只回确认 */
  acknowledged?: boolean
  createdAt: number
}

/** 图片大小上限 10MB */
const MAX_IMAGE_SIZE = 10 * 1024 * 1024

let seq = 0
/** 内网 HTTP 部署下 crypto.randomUUID 不可用，用自增 ID */
const nextId = (prefix: string) => `${prefix}-${Date.now()}-${++seq}`

const unsubscribers = new Map<string, () => void>()
const questionMessage = new Map<string, string>()
let closeBound = false

export const useChatStore = defineStore('chat', {
  state: () => ({
    sessionId: undefined as string | undefined,
    sessionMeta: null as Session | null,
    messages: [] as ChatMessage[],
    asking: false,
    activeQuestionId: '',
    /** 已上传待发送的照片 */
    pendingAttachments: [] as ChatAttachment[],
  }),
  getters: {
    readOnly: (s) => s.sessionMeta?.readOnly === true,
  },
  actions: {
    /** ChatLayout 挂载时调用一次：WS 断线时把进行中的问题标记为中断 */
    init() {
      if (closeBound) return
      closeBound = true
      wsClient.onClose(() => {
        if (!this.asking) return
        const m = this.activeMessage()
        if (m) {
          m.phase = 'error'
          m.errorText = '连接已中断，请重试'
        }
        this.finish(this.activeQuestionId)
      })
    },

    /** 新对话：取消进行中的提问并清空 */
    reset() {
      if (this.asking && this.activeQuestionId) {
        wsClient.send({ type: 'cancel', questionId: this.activeQuestionId })
        this.finish(this.activeQuestionId)
      }
      this.sessionId = undefined
      this.sessionMeta = null
      this.messages = []
      this.pendingAttachments = []
    },

    /** 上传照片到待发区（提问时随 ask 一起发） */
    async uploadImage(file: File) {
      if (!file.type.startsWith('image/')) {
        ElMessage.warning('只能上传图片文件')
        return
      }
      if (file.size > MAX_IMAGE_SIZE) {
        ElMessage.warning('图片不能超过 10MB')
        return
      }
      try {
        const a = await chatApi.uploadImage(file)
        this.pendingAttachments.push(a)
      } catch {
        ElMessage.error('图片上传失败，请重试')
      }
    },

    removeAttachment(id: string) {
      this.pendingAttachments = this.pendingAttachments.filter((x) => x.id !== id)
    },

    async loadSession(sessionId: string) {
      this.reset()
      this.sessionId = sessionId
      try {
        const [meta, records] = await Promise.all([chatApi.session(sessionId), chatApi.messages(sessionId)])
        this.sessionMeta = meta
        this.messages = records.map((r) => ({
          id: r.id,
          role: r.role,
          text: r.text,
          citations: r.citations ?? [],
          attachments: r.attachments ?? [],
          confidence: r.confidence,
          phase: 'done' as MessagePhase,
          createdAt: Date.parse(r.createdAt) || Date.now(),
        }))
      } catch {
        ElMessage.error('会话加载失败')
      }
    },

    async deleteSession() {
      if (!this.sessionId) return
      await chatApi.deleteSession(this.sessionId)
      this.reset()
    },

    async saveSelected(ids: string[]) {
      if (!this.sessionId || !ids.length) return
      try {
        const res = await chatApi.saveSelected({ sessionId: this.sessionId, messageIds: ids })
        for (const m of this.messages) {
          if (ids.includes(m.id)) m.savedToKb = true
        }
        ElMessage.success(res.duplicate ? '这些已经在待确认队列里了' : '已提交，管理员确认后入库')
      } catch {
        ElMessage.error('提交失败，请重试')
      }
    },

    ask(question: string) {
      const q = question.trim()
      // 允许只发照片不发文字
      if (this.readOnly) return
      if ((!q && this.pendingAttachments.length === 0) || this.asking) return

      const attachments = [...this.pendingAttachments]
      this.pendingAttachments = []
      this.messages.push({
        id: nextId('u'),
        role: 'user',
        text: q,
        citations: [],
        attachments,
        phase: 'done',
        createdAt: Date.now(),
      })

      const questionId = nextId('q')
      const assistant: ChatMessage = {
        id: nextId('a'),
        role: 'assistant',
        text: '',
        citations: [],
        phase: 'retrieving',
        createdAt: Date.now(),
      }
      this.messages.push(assistant)
      questionMessage.set(questionId, assistant.id)
      this.asking = true
      this.activeQuestionId = questionId

      unsubscribers.set(
        questionId,
        wsClient.subscribe(questionId, (msg) => this.handleEvent(questionId, msg)),
      )
      wsClient.send({ type: 'ask', questionId, question: q, sessionId: this.sessionId, attachments })
    },

    handleEvent(questionId: string, msg: WsServerMessage) {
      const m = this.messages.find((x) => x.id === questionMessage.get(questionId))
      if (!m) return
      switch (msg.type) {
        case 'status':
          m.phase = msg.phase
          if (msg.phase === 'no_evidence') m.noEvidence = true
          if (msg.phase === 'acknowledged') m.acknowledged = true
          break
        case 'delta':
          m.text += msg.text
          if (m.phase !== 'generating') m.phase = 'generating'
          break
        case 'citation':
          m.citations.push(msg.citation)
          break
        case 'confidence':
          m.confidence = { level: msg.level, score: msg.score }
          break
        case 'done':
          m.phase = 'done'
          this.finish(questionId)
          break
        case 'session':
          this.sessionId = msg.sessionId
          this.sessionMeta = {
            id: msg.sessionId,
            title: '',
            updatedAt: new Date().toISOString(),
            mine: true,
            readOnly: false,
            source: 'web',
          }
          break
        case 'error':
          m.phase = 'error'
          m.errorText = msg.message
          this.finish(questionId)
          break
      }
    },

    cancel() {
      if (!this.activeQuestionId) return
      wsClient.send({ type: 'cancel', questionId: this.activeQuestionId })
      const m = this.activeMessage()
      if (m) m.phase = 'done'
      this.finish(this.activeQuestionId)
    },

    /** 把这条回答（或这条告知）沉淀进知识库：进「待确认」，管理员确认后才入库 */
    async saveToKb(m: ChatMessage) {
      const idx = this.messages.indexOf(m)
      const userMsg = [...this.messages.slice(0, idx)].reverse().find((x) => x.role === 'user')
      try {
        const res = await chatApi.saveToKb({
          question: userMsg?.text ?? '',
          answer: m.text,
          sessionId: this.sessionId,
          citations: m.citations.map((c) => ({ title: c.title })),
        })
        m.savedToKb = true
        ElMessage.success(res.duplicate ? '这条已经在待确认队列里了' : '已提交，管理员确认后入库')
      } catch {
        ElMessage.error('提交失败，请重试')
      }
    },

    /** 依据不足的回答转入问题队列 */
    async submitToQueue(m: ChatMessage) {
      const idx = this.messages.indexOf(m)
      const userMsg = [...this.messages.slice(0, idx)].reverse().find((x) => x.role === 'user')
      if (!userMsg) return
      try {
        await questionApi.submit(userMsg.text, this.sessionId)
        m.submittedToQueue = true
        ElMessage.success('已转入问题队列')
      } catch {
        ElMessage.error('提交失败，请重试')
      }
    },

    activeMessage() {
      return this.messages.find((x) => x.id === questionMessage.get(this.activeQuestionId))
    },

    finish(questionId: string) {
      if (!questionId) return
      unsubscribers.get(questionId)?.()
      unsubscribers.delete(questionId)
      questionMessage.delete(questionId)
      if (this.activeQuestionId === questionId) {
        this.asking = false
        this.activeQuestionId = ''
      }
    },
  },
})
