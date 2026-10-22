/**
 * Mock 数据仓库（内存版，仅开发用）。
 * REST（http.ts）和 WebSocket（ws.ts）共用这一份数据，
 * 所以提问、转队列、确认入库等操作在演示里是联动的。
 */
import type {
  DocItem,
  Field,
  HealthIssue,
  QuestionItem,
  Session,
  SessionMessage,
  User,
} from '../src/types/index'

export interface MockUser extends User {
  password: string
}

export interface MockSession extends Session {
  messages: SessionMessage[]
}

export interface MockDoc extends DocItem {
  content: string
  referencedBy: { sessionId: string; question: string; askedAt: string }[]
  rejectReason?: string
}

// ---------- 账号 ----------
// owner/admin123（主人） admin/admin123（管理员）
// wang/123456（电气） li/123456（机械） zhao/123456（调度）
export const users: MockUser[] = [
  { id: 'u1', name: 'owner', password: 'admin123', role: 'owner', field: null },
  { id: 'u2', name: 'admin', password: 'admin123', role: 'admin', field: null },
  { id: 'u3', name: 'wang', password: '123456', role: 'operator', field: 'electrical' },
  { id: 'u4', name: 'li', password: '123456', role: 'operator', field: 'mechanical' },
  { id: 'u5', name: 'zhao', password: '123456', role: 'operator', field: 'dispatch' },
]

export const guestUser: MockUser = {
  id: 'guest',
  name: '游客',
  password: '',
  role: 'guest',
  field: null,
}

export function publicUser(u: MockUser): User {
  const { password: _pw, ...rest } = u
  return rest
}

/** 按关键词粗分领域（模拟 Hermes 自动分类的建议值） */
export function guessField(text: string): Field {
  if (/变频|配电|电气|电机|PLC|UPS|电缆|开关柜/i.test(text)) return 'electrical'
  if (/锅炉|泵|磨机|空压|减速|轴承|输送|润滑/i.test(text)) return 'mechanical'
  if (/调度|交接班|值班|排产|Excel/i.test(text)) return 'dispatch'
  return 'electrical'
}

// ---------- 会话 ----------
export const sessions: MockSession[] = [
  {
    id: 's1',
    title: '变频器过载跳闸处理',
    updatedAt: '2026-10-16T09:32:00.000Z',
    preview: '变频器过载跳闸（F009）处理步骤：1. 立即停机检查……',
    userId: 'u3',
    userName: 'wang',
    source: 'web',
    messages: [
      {
        id: 's1-m1',
        role: 'user',
        text: '变频器报 F009 过载跳闸怎么处理？',
        citations: [],
        createdAt: '2026-10-16T09:31:30.000Z',
      },
      {
        id: 's1-m2',
        role: 'assistant',
        text: '1. 立即停机检查机械部分是否卡死，手动盘车应灵活。\n2. 用 500V 兆欧表测电机绕组对地绝缘，应 ≥ 0.5MΩ [1]。\n3. 核对变频器电机额定电流参数与铭牌一致。\n4. 排查负载突变原因，检查减速箱油位与联轴器对中 [2]。\n5. 故障复位后空载试运行，观察电流是否平稳。',
        citations: [
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
        ],
        confidence: { level: 'high', score: 0.92 },
        createdAt: '2026-10-16T09:32:00.000Z',
      },
    ],
  },
  {
    id: 's2',
    title: '空压机保养周期咨询',
    updatedAt: '2026-10-15T16:20:00.000Z',
    preview: '空压机日常保养分为班检、月检和年检三个层级……',
    userId: 'u4',
    userName: 'li',
    source: 'agent',
    messages: [
      {
        id: 's2-m1',
        role: 'user',
        text: '空压机多久保养一次？',
        citations: [],
        createdAt: '2026-10-15T16:19:40.000Z',
      },
      {
        id: 's2-m2',
        role: 'assistant',
        text: '空压机保养分为三个层级 [1]：\n- 班检：每班检查油位、排气温度与异响；\n- 月检：更换或清洁空气滤清器，检查皮带张紧度；\n- 年检：更换润滑油与油滤，校验安全阀。\n\n具体周期以设备铭牌与厂家手册为准，高温、多尘环境应适当缩短。',
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
        confidence: { level: 'medium', score: 0.68 },
        createdAt: '2026-10-15T16:20:00.000Z',
      },
    ],
  },
]

// ---------- 文档 ----------
export const docs: MockDoc[] = [
  {
    id: 'd1',
    title: '变频器过载故障处理规程',
    field: 'electrical',
    sensitivity: 'internal',
    status: 'confirmed',
    updatedAt: '2026-10-12T08:00:00.000Z',
    content:
      '1. 适用范围：全厂低压变频器过载类故障（F009、OL2 等）。\n\n2. 故障确认：记录故障代码与跳闸时运行电流，禁止未排查直接复位。\n\n3. 检查项：3.1 手动盘车确认机械无卡死；3.2 电机绕组对地绝缘 ≥ 0.5MΩ（500V 兆欧表）；3.3 核对电机额定电流参数与铭牌一致。\n\n4. 负载排查：4.1 检查减速箱油位与联轴器对中；4.2 30 分钟内连续跳闸两次以上，按《高压配电室操作规程》上报。',
    referencedBy: [
      {
        sessionId: 's1',
        question: '变频器报 F009 过载跳闸怎么处理？',
        askedAt: '2026-10-16T09:32:00.000Z',
      },
    ],
  },
  {
    id: 'd2',
    title: '1号生产线电机保养手册',
    field: 'mechanical',
    sensitivity: 'internal',
    status: 'confirmed',
    updatedAt: '2026-10-10T08:00:00.000Z',
    content:
      '1. 日常保养：每班检查电机温升（≤ 75K）与轴承异响。\n\n2. 月度保养：检查联轴器对中偏差 ≤ 0.05mm；减速箱油位保持在油标中线；补充润滑脂（2号锂基脂）。\n\n3. 年度保养：更换轴承，测量绕组绝缘并记录。',
    referencedBy: [],
  },
  {
    id: 'd3',
    title: '调度交接班记录规范',
    field: 'dispatch',
    sensitivity: 'internal',
    status: 'confirmed',
    updatedAt: '2026-10-08T08:00:00.000Z',
    content:
      '1. 交接内容：在制品数量、设备运行状态、未完成的调度指令、异常事件。\n\n2. 记录要求：交接双方共同签字确认；异常事件须注明处理进展与责任人。\n\n3. 存档：记录保存期两年，电子版每周归档。',
    referencedBy: [],
  },
  {
    id: 'd4',
    title: '高压配电室操作规程',
    field: 'electrical',
    sensitivity: 'confidential',
    status: 'confirmed',
    updatedAt: '2026-09-28T08:00:00.000Z',
    content:
      '1. 进入配电室必须两人同行，穿绝缘鞋、戴绝缘手套。\n\n2. 倒闸操作须填操作票，一人操作一人监护。\n\n3. 设备异常跳闸：30 分钟内连续两次跳闸，禁止强送，立即上报电气主管。',
    referencedBy: [],
  },
  {
    id: 'd5',
    title: '空压机常见故障排查',
    field: 'mechanical',
    sensitivity: 'public',
    status: 'confirmed',
    updatedAt: '2026-09-20T08:00:00.000Z',
    content:
      '1. 排气温度高：检查油位、冷却器与温控阀。\n\n2. 不加载：检查进气阀、电磁阀与压力开关。\n\n3. 保养层级：班检（油位、温度、异响）、月检（空滤、皮带）、年检（润滑油、油滤、安全阀校验）；多尘环境缩短空滤周期。',
    referencedBy: [],
  },
  {
    id: 'd6',
    title: '厂区安全用电须知',
    field: 'electrical',
    sensitivity: 'public',
    status: 'confirmed',
    updatedAt: '2026-09-15T08:00:00.000Z',
    content:
      '1. 非电气人员不得打开配电柜门。\n\n2. 发现电缆破损、设备外壳带电，立即断电并报告电气班。\n\n3. 临时用电须经审批，使用漏电保护器。',
    referencedBy: [],
  },
  {
    id: 'd7',
    title: '2号锅炉给水泵检修记录模板',
    field: 'mechanical',
    sensitivity: 'internal',
    status: 'pending',
    suggestedField: 'mechanical',
    suggestedSensitivity: 'internal',
    updatedAt: '2026-10-16T14:00:00.000Z',
    content:
      '检修记录应包含：泵体振动值、轴承温度、密封泄漏量、联轴器对中数据、更换备件清单与试运记录。',
    referencedBy: [],
  },
  {
    id: 'd8',
    title: '新上输送线 PLC 程序说明',
    field: 'electrical',
    sensitivity: 'internal',
    status: 'pending',
    suggestedField: 'electrical',
    suggestedSensitivity: 'confidential',
    updatedAt: '2026-10-16T15:30:00.000Z',
    content:
      '输送线 PLC 采用 S7-1200，程序分为手动/自动两段。急停回路接入安全继电器，复位需现场确认。',
    referencedBy: [],
  },
  {
    id: 'd9',
    title: '某供应商减速机样本（过期版本）',
    field: 'mechanical',
    sensitivity: 'internal',
    status: 'rejected',
    rejectReason: '版本过期，已联系供应商提供新版',
    updatedAt: '2026-10-11T10:00:00.000Z',
    content: '（已驳回）',
    referencedBy: [],
  },
]

// ---------- 健康检查 ----------
export const issues: HealthIssue[] = [
  {
    id: 'h1',
    type: 'dead_link',
    docId: 'd4',
    docTitle: '高压配电室操作规程',
    detail: '引用的《厂区安全规程 2021 版》链接已失效（现行版本为 2025 版）',
  },
  {
    id: 'h2',
    type: 'orphan_reference',
    docId: 'd1',
    docTitle: '变频器过载故障处理规程',
    detail: '历史对话引用了已删除的页面 kb://电气/旧版变频器手册',
  },
  {
    id: 'h3',
    type: 'format',
    docId: 'd5',
    docTitle: '空压机常见故障排查',
    detail: '正文缺少标题层级，检索切分效果差，建议补充小节标题',
  },
]

// ---------- 问题队列 ----------
export const questions: QuestionItem[] = [
  {
    id: 'q1',
    question: '3号磨机夜间异响原因？白天运行正常',
    askedBy: 'wang',
    field: 'mechanical',
    status: 'open',
    createdAt: '2026-10-16T21:10:00.000Z',
  },
  {
    id: 'q2',
    question: '调度台上 UPS 报警灯常亮怎么处理？',
    askedBy: 'li',
    field: 'electrical',
    status: 'assigned',
    assignee: 'admin',
    createdAt: '2026-10-16T10:05:00.000Z',
  },
  {
    id: 'q3',
    question: '老调度系统导出的 Excel 无法导入新平台',
    askedBy: 'zhao',
    field: 'dispatch',
    status: 'resolved',
    assignee: 'admin',
    createdAt: '2026-10-14T09:00:00.000Z',
  },
]

// ---------- 项目 ----------
export const projects: {
  id: string
  name: string
  status: string
  note: string | null
  kbSource: string
  sourceReady: boolean
  createdAt: string
  memberCount: number
  leads: string[]
}[] = [
  {
    id: 'p-amr01',
    name: '自研 AMR',
    status: 'active',
    note: null,
    kbSource: 'p-amr01',
    sourceReady: true,
    createdAt: '2026-01-01T00:00:00.000Z',
    memberCount: 2,
    leads: ['wang'],
  },
  {
    id: 'tools',
    name: '工具与临时',
    status: 'active',
    note: null,
    kbSource: 'tools',
    sourceReady: true,
    createdAt: '2026-01-01T00:00:00.000Z',
    memberCount: 1,
    leads: [],
  },
  {
    id: '240242',
    name: '火焰处理',
    status: 'active',
    note: '只建了壳，分区未就绪（演示）',
    kbSource: '240242',
    sourceReady: false,
    createdAt: '2026-10-20T00:00:00.000Z',
    memberCount: 0,
    leads: [],
  },
]

// ---------- 聊天照片 ----------
/** 上传的照片按 id 存内存，GET /chat/uploads/:id 时原样返回 */
export const uploads = new Map<string, { name: string; mimeType: string; data: Buffer }>()

// ---------- 启动提示 ----------
let hinted = false
export function printMockHints() {
  if (hinted) return
  hinted = true
  console.log('\n  [mock] 前端 Mock 已启用：REST /api + WebSocket /ws，无需后端')
  console.log('  [mock] 账号：owner/admin123（主人）  admin/admin123（管理员）')
  console.log('  [mock]       wang/123456（电气）  li/123456（机械）  zhao/123456（调度）')
  console.log('  [mock] 也可点「游客进入」。连真实后端请用：npm run dev:real\n')
}
