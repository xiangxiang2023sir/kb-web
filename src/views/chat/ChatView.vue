<script setup lang="ts">
import { nextTick, ref, watch } from 'vue'
import { useRoute } from 'vue-router'
import { storeToRefs } from 'pinia'
import MarkdownIt from 'markdown-it'
import { Close, Picture, Promotion, VideoPause } from '@element-plus/icons-vue'
import { useChatStore, type ChatMessage } from '@/stores/chat'
import CitationCard from '@/components/CitationCard.vue'
import ConfidenceBadge from '@/components/ConfidenceBadge.vue'

// html: false —— 转义原始 HTML，防止注入；需要富 Markdown 渲染时可再扩展
const md = new MarkdownIt({ html: false, linkify: false, breaks: true })
const renderMd = (text: string) => md.render(text)

const route = useRoute()
const chat = useChatStore()
const { messages, asking } = storeToRefs(chat)

const draft = ref('')
const scrollRef = ref<HTMLElement | null>(null)
const fileInput = ref<HTMLInputElement | null>(null)

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

function send() {
  const text = draft.value.trim()
  if (!text && chat.pendingAttachments.length === 0) return
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
    <div ref="scrollRef" class="chat-messages">
      <div v-if="!messages.length" class="chat-empty">
        <h2>向知识库提问</h2>
        <p>回答来自知识库检索，附出处与置信度；答不了的问题可转入问题队列。</p>
      </div>

      <div v-for="m in messages" :key="m.id" class="msg-row" :class="m.role">
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

            <div v-if="m.phase === 'done' && (m.confidence || needsQueue(m))" class="msg-footer">
              <ConfidenceBadge
                v-if="m.confidence"
                :level="m.confidence.level"
                :score="m.confidence.score"
              />
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
    </div>

    <div class="chat-input-area">
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
