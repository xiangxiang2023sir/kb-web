import type { WsClientMessage, WsServerMessage } from '@/types'

type MessageHandler = (msg: WsServerMessage) => void

/** 心跳：每 25s 发 ping，10s 内没收到 pong 判定为僵尸连接，主动关闭走重连 */
const HEARTBEAT_INTERVAL = 25_000
const PONG_TIMEOUT = 10_000

/** 默认同源 /ws（Vite proxy / Nginx 反代），可用 VITE_WS_URL 覆盖为绝对地址 */
function wsUrl(): string {
  const override = import.meta.env.VITE_WS_URL
  if (override) return override
  const scheme = location.protocol === 'https:' ? 'wss' : 'ws'
  return `${scheme}://${location.host}/ws`
}

/**
 * /ws WebSocket 客户端（单例）。
 * - 一条长连接反复提问，事件按 questionId 分发给对应问题的回调
 * - 心跳保活：及时发现半开连接（对端无响应但 TCP 未断）
 * - 断线自动重连（指数退避，上限 10s）；连接断开期间的消息先排队
 */
class WsClient {
  private ws: WebSocket | null = null
  private byQuestion = new Map<string, MessageHandler>()
  private closeHandlers = new Set<() => void>()
  private manualClose = false
  private retryDelay = 1000
  private pending: WsClientMessage[] = []
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null
  private pongTimer: ReturnType<typeof setTimeout> | null = null

  connect() {
    this.manualClose = false
    if (this.ws && this.ws.readyState <= WebSocket.OPEN) return
    const ws = new WebSocket(wsUrl())
    this.ws = ws

    ws.onopen = () => {
      this.retryDelay = 1000
      for (const m of this.pending) this.rawSend(m)
      this.pending = []
      this.startHeartbeat()
    }
    ws.onmessage = (ev) => {
      let msg: WsServerMessage
      try {
        msg = JSON.parse(ev.data as string) as WsServerMessage
      } catch {
        return
      }
      if (msg.type === 'pong') {
        if (this.pongTimer) clearTimeout(this.pongTimer)
        this.pongTimer = null
        return
      }
      const qid = 'questionId' in msg ? msg.questionId : undefined
      const handler = qid ? this.byQuestion.get(qid) : undefined
      if (handler) handler(msg)
    }
    ws.onclose = () => {
      this.stopHeartbeat()
      this.ws = null
      for (const cb of this.closeHandlers) cb()
      if (!this.manualClose) {
        setTimeout(() => this.connect(), this.retryDelay)
        this.retryDelay = Math.min(this.retryDelay * 2, 10000)
      }
    }
  }

  private startHeartbeat() {
    this.stopHeartbeat()
    this.heartbeatTimer = setInterval(() => {
      if (this.ws?.readyState !== WebSocket.OPEN) return
      this.rawSend({ type: 'ping' })
      if (this.pongTimer) clearTimeout(this.pongTimer)
      this.pongTimer = setTimeout(() => {
        // pong 超时：连接已假死，主动关闭（onclose 负责重连）
        this.ws?.close()
      }, PONG_TIMEOUT)
    }, HEARTBEAT_INTERVAL)
  }

  private stopHeartbeat() {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer)
    if (this.pongTimer) clearTimeout(this.pongTimer)
    this.heartbeatTimer = null
    this.pongTimer = null
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
    this.stopHeartbeat()
    this.ws?.close()
    this.ws = null
  }

  private rawSend(msg: WsClientMessage) {
    this.ws?.send(JSON.stringify(msg))
  }
}

export const wsClient = new WsClient()
