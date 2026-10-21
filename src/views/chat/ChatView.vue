<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { storeToRefs } from 'pinia'
import MarkdownIt from 'markdown-it'
import { ElMessage, ElMessageBox } from 'element-plus'
import { Close, Picture, Promotion, VideoPause } from '@element-plus/icons-vue'
import { useChatStore, type ChatMessage } from '@/stores/chat'
import CitationCard from '@/components/CitationCard.vue'
import ConfidenceBadge from '@/components/ConfidenceBadge.vue'
import { chatSourceLabels } from '@/utils/labels'
import { intakeApi, projectsApi } from '@/api/endpoints'

// html: false —— 转义原始 HTML，防止注入；需要富 Markdown 渲染时可再扩展
const md = new MarkdownIt({ html: false, linkify: false, breaks: true })
const renderMd = (text: string) => md.render(text)

const route = useRoute()
const router = useRouter()
const chat = useChatStore()
const { messages, asking, readOnly, sessionMeta } = storeToRefs(chat)

const draft = ref('')
const scrollRef = ref<HTMLElement | null>(null)
const fileInput = ref<HTMLInputElement | null>(null)
const selecting = ref(false)
const selected = ref<Set<string>>(new Set())
const selectedCount = computed(() => selected.value.size)
const sourceText = computed(() =>
  sessionMeta.value?.source ? chatSourceLabels[sessionMeta.value.source] : '',
)

function toggleSelect(id: string, on: boolean) {
  const next = new Set(selected.value)
  if (on) next.add(id)
  else next.delete(id)
  selected.value = next
}

function exitSelect() {
  selecting.value = false
  selected.value = new Set()
}

async function submitSelected() {
  await chat.saveSelected([...selected.value])
  exitSelect()
}

async function removeSession() {
  if (!chat.sessionId) return
  try {
    await ElMessageBox.confirm('删除后无法恢复。确定删掉这场对话？', '删除会话', { type: 'warning' })
  } catch {
    return
  }
  try {
    await chat.deleteSession()
    ElMessage.success('已删除')
    await router.push('/chat/history')
  } catch {
    ElMessage.error('删除失败')
  }
}

watch(
  () => route.params.id,
  (id) => {
    if (id) void chat.loadSession(String(id))
    else chat.reset()
  },
  { immediate: true },
)

// 流式输出时自动滚到底部
watch(
  () => [messages.value.length, messages.value[messages.value.length - 1]?.text] as const,
  async () => {
    await nextTick()
    scrollRef.value?.scrollTo({ top: scrollRef.value.scrollHeight })
  },
)

/** 入库触发词：「入库 xxx」「xxx 入库」「记一下 xxx」「存一下 xxx」 */
const INTAKE_RE = /^(请?帮我)?(入库|记一下|记录一下|存一下|存起来)[:：\s]*|[，,\s]*(入库|存起来)[。！!]?$/

// ---- 入库：先整理，结果做成对话里的卡片（不弹窗） ----
interface IntakeCard {
  id: string
  draft: { title: string; content: string; field: string; sensitivity: string }
  similar: { slug: string; title: string }[]
  project: string
  status: 'draft' | 'submitted'
}
const intakeLoading = ref(false)
const intakeSaving = ref(false)
const intakeCards = ref<IntakeCard[]>([])
const intakeProjects = ref<{ id: string; name: string }[]>([])

async function prepareIntake(raw: string): Promise<boolean> {
  intakeLoading.value = true
  const tip = ElMessage({ message: '正在整理，稍等一下…', type: 'info', duration: 0 })
  try {
    if (!intakeProjects.value.length) intakeProjects.value = await projectsApi.mine().catch(() => [])
    const r = await intakeApi.prepare(raw)
    intakeCards.value.push({
      id: `ic-${Date.now()}`,
      draft: r.draft,
      similar: r.similar || [],
      project: r.draft.project || '',
      status: 'draft',
    })
    return true
  } catch (e) {
    const msg = (e as { response?: { data?: { message?: string } } })?.response?.data?.message || '整理失败，已按普通提问发出'
    ElMessage.error(msg)
    return false
  } finally {
    tip.close()
    intakeLoading.value = false
  }
}

async function submitIntake(card: IntakeCard) {
  intakeSaving.value = true
  try {
    await intakeApi.save({
      title: card.draft.title,
      content: card.draft.content,
      field: card.draft.field,
      sensitivity: card.draft.sensitivity,
      project: card.project || null,
      sessionId: chat.sessionId || undefined,
    })
    card.status = 'submitted'
    ElMessage.success('已提交，进「待确认」等审核')
  } catch (e) {
    const msg = (e as { response?: { data?: { message?: string } } })?.response?.data?.message || '提交失败'
    ElMessage.error(msg)
  } finally {
    intakeSaving.value = false
  }
}

function editIntake(card: IntakeCard) {
  draft.value = `入库 ${card.draft.content.replace(/\n\n---\n\n### 原始表述[\s\S]*$/, '').trim()}`
  dropIntake(card)
}

function dropIntake(card: IntakeCard) {
  intakeCards.value = intakeCards.value.filter((c) => c.id !== card.id)
}

async function send() {
  const text = draft.value.trim()
  if (!text && chat.pendingAttachments.length === 0) return
  if (text && INTAKE_RE.test(text)) {
    draft.value = ''
    const ok = await prepareIntake(text)
    if (!ok) {
      chat.ask(text)
    }
    return
  }
  chat.ask(text)
  draft.value = ''
}

/** 选择照片上传 */
function onPick(e: Event) {
  const input = e.target as HTMLInputElement
  for (const f of Array.from(input.files ?? [])) void chat.uploadImage(f)
  input.value = ''
}

/** 截图后直接 Ctrl+V 粘贴发送 */
function onPaste(e: ClipboardEvent) {
  const items = Array.from(e.clipboardData?.items ?? [])
  const images = items.filter((i) => i.type.startsWith('image/'))
  if (!images.length) return
  e.preventDefault()
  for (const i of images) {
    const f = i.getAsFile()
    if (f) void chat.uploadImage(f)
  }
}

/** 依据不足：低置信度，或检索阶段就告知没有出处 */
function needsQueue(m: ChatMessage) {
  return m.phase === 'done' && (m.noEvidence || m.confidence?.level === 'low')
}

function retry(m: ChatMessage) {
  const idx = chat.messages.indexOf(m)
  const q = [...chat.messages.slice(0, idx)].reverse().find((x) => x.role === 'user')
  if (q) chat.ask(q.text)
}
</script>

<template>
  <div class="chat-view">
    <div v-if="chat.sessionId" class="chat-toolbar">
      <div class="toolbar-meta">
        <el-tag v-if="sourceText" size="small" effect="plain">{{ sourceText }}</el-tag>
        <span v-if="readOnly" class="toolbar-note">
          这是 {{ sessionMeta?.userName || '他人' }} 的会话，只读。可勾选入库或删除。
        </span>
        <span v-else-if="sessionMeta?.title" class="toolbar-note">{{ sessionMeta.title }}</span>
      </div>
      <div class="toolbar-actions">
        <el-button v-if="!selecting" size="small" @click="selecting = true">选择入库</el-button>
        <template v-else>
          <el-button size="small" @click="exitSelect">取消</el-button>
          <el-button size="small" type="success" :disabled="!selectedCount" @click="submitSelected">
            选中 {{ selectedCount }} 条入库
          </el-button>
        </template>
        <el-button size="small" type="danger" plain @click="removeSession">删除会话</el-button>
      </div>
    </div>
    <div ref="scrollRef" class="chat-messages">
      <div v-if="!messages.length" class="chat-empty">
        <h2>向知识库提问</h2>
        <p>问设备、规程或故障会检索资料并附出处；打招呼、闲聊也可以直接说。</p>
      </div>

      <div v-for="m in messages" :key="m.id" class="msg-row" :class="m.role">
        <el-checkbox
          v-if="selecting && m.role === 'assistant' && m.phase === 'done' && m.text"
          class="msg-check"
          :model-value="selected.has(m.id)"
          @change="(v: boolean | string | number) => toggleSelect(m.id, v === true)"
        />
        <div class="msg-bubble">
          <template v-if="m.role === 'user'">
            <div v-if="m.attachments?.length" class="msg-attachments">
              <el-image
                v-for="(a, i) in m.attachments"
                :key="a.id"
                :src="a.url"
                fit="cover"
                :preview-src-list="m.attachments.map((x) => x.url)"
                :initial-index="i"
                preview-teleported
              />
            </div>
            <div v-if="m.text" class="msg-text">{{ m.text }}</div>
          </template>

          <template v-else>
            <div
              v-if="(m.phase === 'retrieving' || m.phase === 'no_evidence') && !m.text"
              class="msg-status"
              :class="{ warn: m.phase === 'no_evidence' }"
            >
              {{ m.phase === 'retrieving' ? '正在检索知识库…' : '知识库中未找到相关依据' }}
            </div>

            <div v-if="m.text" class="msg-text markdown" v-html="renderMd(m.text)"></div>
            <span v-if="m.phase === 'generating'" class="caret">▍</span>

            <CitationCard v-for="(c, i) in m.citations" :key="c.id" :citation="c" :index="i + 1" />

            <div v-if="m.phase === 'done'" class="msg-footer">
              <ConfidenceBadge
                v-if="m.confidence"
                :level="m.confidence.level"
                :score="m.confidence.score"
              />
              <el-tag v-if="m.acknowledged" size="small" type="info" effect="plain">这是告知，未查知识库</el-tag>
              <el-button
                size="small"
                type="success"
                plain
                :disabled="m.savedToKb"
                @click="chat.saveToKb(m)"
              >
                {{ m.savedToKb ? '已提交待确认' : '存入知识库' }}
              </el-button>
              <el-alert v-if="needsQueue(m)" type="warning" :closable="false" show-icon title="回答依据不足">
                <template #default>
                  <div class="queue-tip">
                    <span>回答可能不完整，可转入问题队列，由领域责任人解答后入库。</span>
                    <el-button
                      size="small"
                      type="warning"
                      plain
                      :disabled="m.submittedToQueue"
                      @click="chat.submitToQueue(m)"
                    >
                      {{ m.submittedToQueue ? '已转入问题队列' : '转入问题队列' }}
                    </el-button>
                  </div>
                </template>
              </el-alert>
            </div>

            <div v-if="m.phase === 'error'" class="msg-error">
              <el-alert type="error" :closable="false" show-icon :title="m.errorText || '出错了，请重试'" />
              <el-button size="small" @click="retry(m)">重试</el-button>
            </div>
          </template>
        </div>
      </div>
      <!-- 入库卡片：插在消息流末尾，不弹窗 -->
      <div v-for="card in intakeCards" :key="card.id" class="msg-row assistant">
        <div class="intake-card">
          <div class="intake-head">
            <el-icon><Files /></el-icon>
            <span>入库预览（会先进「待确认」）</span>
            <el-tag v-if="card.status === 'submitted'" size="small" type="success" style="margin-left: auto">已进待确认</el-tag>
          </div>
          <div class="intake-title">{{ card.draft.title }}</div>
          <div class="intake-meta">
            <el-tag size="small">{{ card.draft.field }}</el-tag>
            <el-tag size="small" type="info">{{ card.draft.sensitivity }}</el-tag>
            <el-select v-model="card.project" placeholder="归属项目（不选=公共库）" clearable size="small" style="width: 190px" :disabled="card.status === 'submitted'">
              <el-option v-for="pj in intakeProjects" :key="pj.id" :label="pj.name" :value="pj.id" />
            </el-select>
          </div>
          <div v-if="card.similar.length" class="intake-warn">
            可能重复：<span v-for="s in card.similar" :key="s.slug" class="dup">{{ s.title }}</span>
          </div>
          <div class="intake-body" v-html="renderMd(card.draft.content)" />
          <div v-if="card.status === 'draft'" class="intake-actions">
            <el-button size="small" type="primary" :loading="intakeSaving" @click="submitIntake(card)">确认入库</el-button>
            <el-button size="small" @click="editIntake(card)">改一下</el-button>
            <el-button size="small" text @click="dropIntake(card)">算了</el-button>
          </div>
        </div>
      </div>
    </div>

    <div v-if="!readOnly" class="chat-input-area">
      <div v-if="chat.pendingAttachments.length" class="attach-list">
        <div v-for="a in chat.pendingAttachments" :key="a.id" class="attach-item">
          <el-image :src="a.url" fit="cover" :preview-src-list="[a.url]" preview-teleported />
          <el-icon class="remove" @click="chat.removeAttachment(a.id)"><Close /></el-icon>
        </div>
      </div>
      <div class="chat-input">
        <input ref="fileInput" type="file" accept="image/*" multiple hidden @change="onPick" />
        <el-button :icon="Picture" circle title="上传照片（也可直接粘贴截图）" @click="fileInput?.click()" />
        <el-input
          v-model="draft"
          type="textarea"
          :rows="3"
          resize="none"
          placeholder="输入问题，Enter 发送，Shift+Enter 换行；可上传或粘贴照片"
          @keydown.enter.exact.prevent="send"
          @paste="onPaste"
        />
        <el-button
          v-if="!asking"
          type="primary"
          :icon="Promotion"
          :disabled="!draft.trim() && chat.pendingAttachments.length === 0"
          class="send-btn"
          @click="send"
        >
          发送
        </el-button>
        <el-button v-else :icon="VideoPause" class="send-btn" @click="chat.cancel()">停止</el-button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.chat-view {
  display: flex;
  flex-direction: column;
  height: 100%;
}

.chat-toolbar {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 12px;
  padding: 8px 20px;
  border-bottom: 1px solid var(--kb-border);
  background: #fff;
  flex-wrap: wrap;
}

.toolbar-meta {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}

.toolbar-note {
  color: var(--kb-text-secondary);
  font-size: 13px;
}

.toolbar-actions {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}

.msg-check {
  margin-right: 8px;
  align-self: center;
}

.chat-messages {
  flex: 1;
  overflow-y: auto;
  padding: 24px 20px 12px;
}

.chat-empty {
  text-align: center;
  color: var(--kb-text-secondary);
  margin-top: 15vh;
}

.chat-empty h2 {
  color: var(--kb-text);
  font-weight: 600;
  margin: 0 0 8px;
}

.msg-row {
  display: flex;
  margin-bottom: 16px;
}

.msg-row.user {
  justify-content: flex-end;
}

.msg-bubble {
  max-width: 760px;
  padding: 12px 16px;
  border-radius: 8px;
  line-height: 1.7;
}

.msg-row.user .msg-bubble {
  background: #e3ecfd;
  border: 1px solid #c8d9f7;
}

.msg-row.assistant .msg-bubble {
  width: 100%;
  min-width: 280px;
  background: #fff;
  border: 1px solid var(--kb-border);
}

.msg-text {
  white-space: pre-wrap;
  word-break: break-word;
}

.msg-status {
  color: var(--kb-text-secondary);
}

.msg-status.warn {
  color: var(--el-color-warning);
}

.caret {
  display: inline-block;
  animation: blink 1s steps(1) infinite;
}

@keyframes blink {
  50% {
    opacity: 0;
  }
}

.msg-footer {
  margin-top: 10px;
  display: flex;
  flex-direction: column;
  gap: 8px;
  align-items: flex-start;
}

.queue-tip {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
  margin-top: 2px;
}

.msg-error {
  margin-top: 10px;
  display: flex;
  gap: 8px;
  align-items: center;
}

.chat-input-area {
  background: #fff;
  border-top: 1px solid var(--kb-border);
}

.chat-input {
  display: flex;
  gap: 10px;
  padding: 12px 20px 16px;
  align-items: flex-end;
}

.attach-list {
  display: flex;
  gap: 10px;
  padding: 12px 20px 0;
  flex-wrap: wrap;
}

.attach-item {
  position: relative;
  width: 72px;
  height: 72px;
  border: 1px solid var(--kb-border);
  border-radius: 6px;
  overflow: hidden;
}

.attach-item .el-image {
  width: 100%;
  height: 100%;
  display: block;
}

.attach-item .remove {
  position: absolute;
  top: 2px;
  right: 2px;
  width: 18px;
  height: 18px;
  border-radius: 50%;
  background: rgba(0, 0, 0, 0.55);
  color: #fff;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 12px;
}

.msg-attachments {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
  margin-bottom: 8px;
}

.msg-attachments .el-image {
  width: 140px;
  height: 140px;
  border-radius: 6px;
  border: 1px solid var(--kb-border);
  cursor: zoom-in;
}

.send-btn {
  height: auto;
  align-self: stretch;
}

/* v-html 渲染的 Markdown 内容没有 scoped 属性，需要 :deep */
.markdown {
  white-space: normal;
}

.markdown :deep(p) {
  margin: 0 0 8px;
}

.markdown :deep(p:last-child) {
  margin-bottom: 0;
}

.markdown :deep(ul),
.markdown :deep(ol) {
  margin: 6px 0;
  padding-left: 22px;
}

.markdown :deep(code) {
  background: #f0f1f3;
  padding: 1px 5px;
  border-radius: 4px;
}

.markdown :deep(pre) {
  background: #f0f1f3;
  padding: 10px;
  border-radius: 6px;
  overflow-x: auto;
}

@media (prefers-reduced-motion: reduce) {
  .caret {
    animation: none;
  }
}
</style>

<style scoped>
.intake-card {
  background: #fff;
  border: 1px solid #e4e7ed;
  border-left: 3px solid #409eff;
  border-radius: 8px;
  padding: 12px 14px;
  max-width: 720px;
  box-shadow: 0 1px 4px rgba(0, 0, 0, 0.04);
}
.intake-head {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  color: #909399;
  margin-bottom: 8px;
}
.intake-actions {
  margin-top: 10px;
  display: flex;
  gap: 8px;
}
.intake-title { font-size: 15px; font-weight: 600; margin-bottom: 8px; }
.intake-meta { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; }
.intake-card .intake-title { font-size: 15px; font-weight: 600; margin-bottom: 8px; }
.intake-warn { font-size: 12px; color: #e6a23c; margin-bottom: 8px; }
.intake-warn .dup { margin-right: 8px; text-decoration: underline; }
.intake-body {
  max-height: 46vh; overflow: auto; background: #fafafa; border-radius: 6px;
  padding: 10px 14px; line-height: 1.7; font-size: 13px;
}
</style>
