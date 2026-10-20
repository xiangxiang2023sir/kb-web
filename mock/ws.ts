/**
 * Mock WebSocket 问答流（仅开发用）。
 * 挂在 /ws 上，按 src/types/index.ts 的协议推事件：
 * status → delta…（穿插 citation）→ confidence → done。
 * 根据问题关键词匹配预设答案；匹配不到就走「依据不足」流程，方便演示转问题队列。
 */
import { WebSocketServer, type WebSocket } from 'ws'
import type { IncomingMessage } from 'node:http'
import type { Duplex } from 'node:stream'
import { sessions } from './data'
import type { Citation, ConfidenceLevel, SessionMessage, WsClientMessage } from '../src/types/index'

interface CannedAnswer {
  match: RegExp
  /** false 时先推 no_evidence 状态（演示「依据不足 → 转问题队列」） */
  evidence: boolean
  confidence: { level: ConfidenceLevel; score: number }
  citations: Citation[]
  text: string
}

const inverterCitations: Citation[] = [
  {
    id: 'c1',
    title: '变频器过载故障处理规程',
    path: 'kb://电气/变频器过载故障处理规程',
    snippet:
      '3.2 电机绕组对地绝缘电阻应不小于 0.5MΩ（500V 兆欧表）。4.1 过载跳闸后应检查减速箱油位与联轴器对中情况。',
    field: 'electrical',
    sensitivity: 'internal',
    marker: '[1]',
  },
  {
    id: 'c2',
    title: '1号生产线电机保养手册',
    path: 'kb://机械/电机保养手册',
    snippet: '每月检查联轴器对中偏差 ≤ 0.05mm；减速箱油位保持在油标中线。',
    field: 'mechanical',
    sensitivity: 'internal',
    marker: '[2]',
  },
]

const answers: CannedAnswer[] = [
  {
    match: /变频|过载|跳闸|F009/i,
    evidence: true,
    confidence: { level: 'high', score: 0.92 },
    citations: inverterCitations,
    text: `## 变频器过载跳闸（F009）处理步骤

1. **立即停机检查**：确认电机与负载机械部分无卡死，手动盘车应灵活。
2. **测量电机绝缘**：用 500V 兆欧表测绕组对地绝缘，应 ≥ 0.5MΩ [1]。
3. **检查电流设定**：核对变频器中电机额定电流参数（P0305）与铭牌一致。
4. **排查负载原因**：过载多由负载突变引起，检查减速箱油位与联轴器对中 [2]。
5. **复位试运行**：故障复位后空载启动，观察运行电流是否平稳。

> 注意：30 分钟内连续跳闸两次以上，禁止强行复位，按《高压配电室操作规程》上报。`,
  },
  {
    match: /保养|维护|空压|润滑/i,
    evidence: true,
    confidence: { level: 'medium', score: 0.68 },
    citations: [
      {
        id: 'c3',
        title: '空压机常见故障排查',
        path: 'kb://机械/空压机常见故障排查',
        snippet: '保养分为班检、月检、年检三个层级；多尘环境应缩短滤清器更换周期。',
        field: 'mechanical',
        sensitivity: 'public',
        marker: '[1]',
      },
    ],
    text: `空压机保养分为三个层级 [1]：

- **班检**：每班检查油位、排气温度与异响；
- **月检**：更换或清洁空气滤清器，检查皮带张紧度；
- **年检**：更换润滑油与油滤，校验安全阀。

具体周期以设备铭牌与厂家手册为准，高温、多尘环境应适当缩短。知识库中暂无本厂具体机型的保养记录，以上为通用规程。`,
  },
  {
    match: /调度|交接班|值班/i,
    evidence: true,
    confidence: { level: 'high', score: 0.88 },
    citations: [
      {
        id: 'c4',
        title: '调度交接班记录规范',
        path: 'kb://调度/调度交接班记录规范',
        snippet: '交接内容：在制品数量、设备运行状态、未完成的调度指令、异常事件；双方共同签字确认。',
        field: 'dispatch',
        sensitivity: 'internal',
        marker: '[1]',
      },
    ],
    text: `## 调度交接班要点

按《调度交接班记录规范》[1]，交接班必须覆盖四项内容：

1. **在制品数量**：各产线当前工单进度；
2. **设备运行状态**：运行、停机、检修中的设备清单；
3. **未完成的调度指令**：逐条说明进展；
4. **异常事件**：注明处理进展与责任人。

交接双方共同签字确认，记录保存期两年，电子版每周归档。`,
  },
]

const fallback: CannedAnswer = {
  match: /.*/,
  evidence: false,
  confidence: { level: 'low', score: 0.21 },
  citations: [],
  text: '知识库中没有找到与该问题直接相关的资料。为避免误导，我不做推测性回答。你可以将问题转入问题队列，由领域责任人解答后入库。',
}

function pickAnswer(q: string): CannedAnswer {
  return answers.find((a) => a.match.test(q)) ?? fallback
}

// ---------- WebSocket 服务 ----------

const wss = new WebSocketServer({ noServer: true })

export function handleWsUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer) {
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req))
}

function send(ws: WebSocket, msg: unknown) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg))
}

type AskMsg = Extract<WsClientMessage, { type: 'ask' }>

wss.on('connection', (ws: WebSocket) => {
  const timers = new Map<string, NodeJS.Timeout>()

  ws.on('message', (raw) => {
    let msg: WsClientMessage
    try {
      msg = JSON.parse(String(raw)) as WsClientMessage
    } catch {
      return
    }
    if (msg.type === 'ping') send(ws, { type: 'pong' })
    else if (msg.type === 'ask') handleAsk(ws, msg, timers)
    else if (msg.type === 'cancel') {
      clearTimeout(timers.get(msg.questionId))
      timers.delete(msg.questionId)
      send(ws, { type: 'done', questionId: msg.questionId })
    }
  })

  ws.on('close', () => {
    for (const t of timers.values()) clearTimeout(t)
    timers.clear()
  })
})

/** 有照片时在回答前加一段「看图」说明，模拟视觉分析 */
function withPhotoNote(ans: CannedAnswer, msg: AskMsg): CannedAnswer {
  const n = msg.attachments?.length ?? 0
  if (!n) return ans
  if (!ans.evidence) {
    return {
      ...ans,
      text: `已收到你上传的 ${n} 张照片，但结合照片与问题仍没有找到足够依据。为避免误导，我不做推测性回答。你可以将问题转入问题队列，由领域责任人解答后入库。`,
    }
  }
  const note = /变频|过载|跳闸|F009/i.test(msg.question)
    ? '从照片看，变频器面板显示故障码 F009，属于过载跳闸。结合知识库规程：\n\n'
    : `已收到你上传的 ${n} 张照片，结合知识库分析如下：\n\n`
  return { ...ans, text: note + ans.text }
}

function handleAsk(ws: WebSocket, msg: AskMsg, timers: Map<string, NodeJS.Timeout>) {
  const ans = withPhotoNote(pickAnswer(msg.question), msg)
  const later = (fn: () => void, ms: number) => {
    timers.set(
      msg.questionId,
      setTimeout(() => {
        timers.delete(msg.questionId)
        fn()
      }, ms),
    )
  }

  send(ws, { type: 'status', questionId: msg.questionId, phase: 'retrieving' })
  later(() => {
    if (!ans.evidence) {
      send(ws, { type: 'status', questionId: msg.questionId, phase: 'no_evidence' })
      later(() => streamAll(ws, msg, ans, timers), 700)
      return
    }
    send(ws, { type: 'status', questionId: msg.questionId, phase: 'generating' })
    later(() => streamAll(ws, msg, ans, timers), 300)
  }, 900)
}

function streamAll(
  ws: WebSocket,
  msg: AskMsg,
  ans: CannedAnswer,
  timers: Map<string, NodeJS.Timeout>,
) {
  const chunks: string[] = []
  for (let i = 0; i < ans.text.length; i += 8) chunks.push(ans.text.slice(i, i + 8))
  let i = 0
  let cited = 0

  const step = () => {
    if (i < chunks.length) {
      send(ws, { type: 'delta', questionId: msg.questionId, text: chunks[i] })
      // 按进度均匀插入引用事件
      const progress = (i + 1) / chunks.length
      if (cited < ans.citations.length && progress > (cited + 1) / (ans.citations.length + 1)) {
        send(ws, { type: 'citation', questionId: msg.questionId, citation: ans.citations[cited] })
        cited++
      }
      i++
      timers.set(msg.questionId, setTimeout(step, 45))
      return
    }
    while (cited < ans.citations.length) {
      send(ws, { type: 'citation', questionId: msg.questionId, citation: ans.citations[cited] })
      cited++
    }
    send(ws, {
      type: 'confidence',
      questionId: msg.questionId,
      level: ans.confidence.level,
      score: ans.confidence.score,
    })
    send(ws, { type: 'done', questionId: msg.questionId })
    timers.delete(msg.questionId)
    persist(msg, ans)
  }
  step()
}

/** 把问答写入会话，历史会话页面就能看到本次提问 */
function persist(msg: AskMsg, ans: CannedAnswer) {
  const time = new Date().toISOString()
  const userMsg: SessionMessage = {
    id: `m-${Date.now()}-u`,
    role: 'user',
    text: msg.question,
    attachments: msg.attachments,
    citations: [],
    createdAt: time,
  }
  const assistantMsg: SessionMessage = {
    id: `m-${Date.now()}-a`,
    role: 'assistant',
    text: ans.text,
    citations: ans.citations,
    confidence: ans.confidence,
    createdAt: time,
  }
  const existing = msg.sessionId ? sessions.find((s) => s.id === msg.sessionId) : undefined
  if (existing) {
    existing.messages.push(userMsg, assistantMsg)
    existing.updatedAt = time
    existing.preview = ans.text.slice(0, 50)
  } else {
    sessions.unshift({
      id: `s-${Date.now()}`,
      title: msg.question.slice(0, 20) || '[照片咨询]',
      updatedAt: time,
      preview: ans.text.slice(0, 50),
      userId: 'u1',
      userName: 'owner',
      source: 'web',
      messages: [userMsg, assistantMsg],
    })
  }
}
