import type { WsClientMessage, WsServerMessage } from '@/types'

type MessageHandler = (msg: WsServerMessage) => void

/**
 * /ws WebSocket 客户端（单例）。
 * - 一条长连接反复提问，事件按 questionId 分发给对应问题的回调
 * - 断线自动重连（指数退避，上限 10s）；连接断开期间的消息先排队
 * - 开发与生产都走同源相对路径（Vite proxy / Nginx 反代）
 */
class WsClient {
  private ws: WebSocket | null = null
  private byQuestion = new Map<string, MessageHandler>()
  private closeHandlers = new Set<() => void>()
  private manualClose = false
  private retryDelay = 1000
  private pending: WsClientMessage[] = []

  connect() {
    this.manualClose = false
    if (this.ws && this.ws.readyState <= WebSocket.OPEN) return
    const scheme = location.protocol === 'https:' ? 'wss' : 'ws'
    const ws = new WebSocket(`${scheme}://${location.host}/ws`)
    this.ws = ws

    ws.onopen = () => {
      this.retryDelay = 1000
      for (const m of this.pending) this.rawSend(m)
      this.pending = []
    }
    ws.onmessage = (ev) => {
      let msg: WsServerMessage
      try {
        msg = JSON.parse(ev.data as string) as WsServerMessage
      } catch {
        return
      }
      const qid = 'questionId' in msg ? msg.questionId : undefined
      const handler = qid ? this.byQuestion.get(qid) : undefined
      if (handler) handler(msg)
    }
    ws.onclose = () => {
      this.ws = null
      for (const cb of this.closeHandlers) cb()
      if (!this.manualClose) {
        setTimeout(() => this.connect(), this.retryDelay)
        this.retryDelay = Math.min(this.retryDelay * 2, 10000)
      }
    }
  }

  /** 订阅某个问题的流式事件，返回取消订阅函数 */
  subscribe(questionId: string, handler: MessageHandler): () => void {
    this.byQuestion.set(questionId, handler)
    return () => {
      this.byQuestion.delete(questionId)
    }
  }

  /** 连接断开时回调（用于把进行中的问题标记为中断） */
  onClose(cb: () => void): () => void {
    this.closeHandlers.add(cb)
    return () => {
      this.closeHandlers.delete(cb)
    }
  }

  send(msg: WsClientMessage) {
    this.connect()
    if (this.ws?.readyState === WebSocket.OPEN) this.rawSend(msg)
    else this.pending.push(msg)
  }

  disconnect() {
    this.manualClose = true
    this.ws?.close()
    this.ws = null
  }

  private rawSend(msg: WsClientMessage) {
    this.ws?.send(JSON.stringify(msg))
  }
}

export const wsClient = new WsClient()
