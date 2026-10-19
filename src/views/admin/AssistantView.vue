<script setup lang="ts">
import { computed, nextTick, onMounted, ref } from 'vue'
import { ElMessage } from 'element-plus'
import { Picture, Close, Promotion } from '@element-plus/icons-vue'
import { assistantApi, chatApi, type AssistantTurn } from '@/api/endpoints'
import { useAuthStore } from '@/stores/auth'

const auth = useAuthStore()
const STORAGE_KEY = 'kb.assistant.turns.v2'

interface Shot {
  id: string
  url: string
  name: string
}

const turns = ref<AssistantTurn[]>([])
const shots = ref<Shot[]>([])
const draft = ref('')
const pending = ref(false)
const uploading = ref(false)
const errorText = ref('')
const listRef = ref<HTMLElement | null>(null)
const fileRef = ref<HTMLInputElement | null>(null)
let controller: AbortController | null = null

const canSend = computed(() => (draft.value.trim().length > 0 || shots.value.length > 0) && !pending.value && !uploading.value)

onMounted(() => {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw) turns.value = JSON.parse(raw).slice(-20)
  } catch {
    /* 忽略损坏的本地缓存 */
  }
})

function persist() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(turns.value.slice(-20)))
  } catch {
    /* 存不下就算了 */
  }
}

async function scrollToBottom() {
  await nextTick()
  const el = listRef.value
  if (el) el.scrollTop = el.scrollHeight
}

function clearAll() {
  controller?.abort()
  pending.value = false
  turns.value = []
  shots.value = []
  errorText.value = ''
  persist()
}

function stop() {
  controller?.abort()
  pending.value = false
}

function pickFiles() {
  fileRef.value?.click()
}

async function uploadOne(file: File) {
  if (!file.type.startsWith('image/')) return
  uploading.value = true
  try {
    const res = await chatApi.uploadImage(file)
    shots.value.push({ id: res.id, url: res.url, name: res.name || '截图' })
  } catch (err) {
    ElMessage.error('截图上传失败：' + ((err as Error).message || '未知错误'))
  } finally {
    uploading.value = false
  }
}

async function onFileChange(event: Event) {
  const input = event.target as HTMLInputElement
  const files = Array.from(input.files ?? [])
  for (const f of files.slice(0, 4)) await uploadOne(f)
  input.value = ''
}

async function onPaste(event: ClipboardEvent) {
  const items = Array.from(event.clipboardData?.items ?? [])
  const images = items.filter((i) => i.type.startsWith('image/')).map((i) => i.getAsFile()).filter(Boolean) as File[]
  if (!images.length) return
  event.preventDefault()
  for (const f of images.slice(0, 4)) await uploadOne(f)
  ElMessage.success('截图已添加')
}

async function onDrop(event: DragEvent) {
  const files = Array.from(event.dataTransfer?.files ?? [])
  const images = files.filter((f) => f.type.startsWith('image/'))
  if (!images.length) return
  for (const f of images.slice(0, 4)) await uploadOne(f)
}

function removeShot(i: number) {
  shots.value.splice(i, 1)
}

async function send() {
  const text = draft.value.trim()
  if ((!text && !shots.value.length) || pending.value) return
  const images = shots.value.map((s) => s.url)
  draft.value = ''
  shots.value = []
  errorText.value = ''
  turns.value.push({ role: 'user', content: text || '（见截图）' })
  turns.value.push({ role: 'assistant', content: '' })
  const answer = turns.value[turns.value.length - 1]
  pending.value = true
  persist()
  await scrollToBottom()

  controller = new AbortController()
  try {
    await assistantApi.chat(
      turns.value.filter((t) => t.content.trim().length > 0),
      (delta) => {
        answer.content += delta
        void scrollToBottom()
      },
      controller.signal,
      images,
    )
    if (!answer.content.trim()) answer.content = '（小A 没有返回内容）'
  } catch (err) {
    const message = (err as Error).message || '请求失败'
    if (message.includes('abort') || (err as Error).name === 'AbortError') {
      answer.content += answer.content ? '\n\n（已停止）' : '（已停止）'
    } else {
      errorText.value = message
      turns.value.pop()
      ElMessage.error(message)
    }
  } finally {
    pending.value = false
    controller = null
    persist()
    await scrollToBottom()
  }
}

function onKeydown(event: KeyboardEvent) {
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
    event.preventDefault()
    void send()
  }
}

const starters = [
  '行走电机参数怎么配？maxRPM 怎么算？',
  '富锐 H1E0-06B 雷达在 Roboshop 里怎么配？',
  '底盘 Modbus 里怎么让车重定位？',
  '这个报警码是什么意思？（我贴截图）',
]

function useStarter(text: string) {
  draft.value = text
}
</script>

<template>
  <div class="assistant" @paste="onPaste" @dragover.prevent @drop.prevent="onDrop">
    <div class="assistant-head">
      <div>
        <div class="title">AI知识库管理助手 <span class="badge">小A · AGV 电气</span></div>
        <div class="hint">
          可以直接问，也可以粘贴截图或拖进来（报警界面 / 参数页 / 图纸都行）。{{ auth.user?.name }} · 结论以现场实测为准。
        </div>
      </div>
      <div class="ops">
        <el-button v-if="pending" size="small" type="warning" plain @click="stop">停止</el-button>
        <el-button size="small" plain :disabled="!turns.length && !shots.length" @click="clearAll">清空</el-button>
      </div>
    </div>

    <div ref="listRef" class="assistant-list">
      <div v-if="!turns.length" class="empty">
        <div class="empty-title">问点什么吧，或者按 Ctrl+V 粘一张截图</div>
        <div class="starters">
          <el-button v-for="s in starters" :key="s" size="small" plain @click="useStarter(s)">{{ s }}</el-button>
        </div>
      </div>

      <div v-for="(m, i) in turns" :key="i" class="turn" :class="m.role">
        <div class="who">{{ m.role === 'user' ? '我' : '小A' }}</div>
        <div class="bubble">
          <span v-if="m.content" class="text">{{ m.content }}</span>
          <span v-else class="typing">小A 正在想…</span>
        </div>
      </div>

      <el-alert v-if="errorText" :title="errorText" type="error" :closable="false" show-icon class="err" />
    </div>

    <div class="assistant-input">
      <div v-if="shots.length || uploading" class="shots">
        <div v-for="(s, i) in shots" :key="s.id" class="shot">
          <img :src="s.url" :alt="s.name" />
          <button class="shot-x" type="button" @click="removeShot(i)">
            <el-icon><Close /></el-icon>
          </button>
        </div>
        <div v-if="uploading" class="shot shot-loading">上传中…</div>
      </div>

      <el-input
        v-model="draft"
        type="textarea"
        :rows="3"
        resize="none"
        placeholder="说说你的问题…（Enter 发送，Shift+Enter 换行；Ctrl+V 可直接粘截图）"
        @keydown="onKeydown"
      />

      <div class="actions">
        <div class="left">
          <el-button size="small" plain :icon="Picture" :loading="uploading" @click="pickFiles">传截图</el-button>
          <span class="tip">支持 Ctrl+V 粘贴 / 拖拽；最多 4 张</span>
        </div>
        <el-button type="primary" :icon="Promotion" :loading="pending" :disabled="!canSend" @click="send">发送</el-button>
      </div>
      <input ref="fileRef" type="file" accept="image/*" multiple class="hidden-file" @change="onFileChange" />
    </div>
  </div>
</template>

<style scoped>
.assistant {
  display: flex;
  flex-direction: column;
  height: calc(100vh - 120px);
  gap: 12px;
}
.assistant-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
}
.title {
  font-size: 17px;
  font-weight: 600;
}
.badge {
  margin-left: 8px;
  font-size: 12px;
  font-weight: 500;
  color: #0b7a46;
  background: rgba(18, 160, 92, 0.12);
  padding: 2px 8px;
  border-radius: 999px;
}
.hint {
  margin-top: 4px;
  font-size: 12.5px;
  color: #8492a6;
}
.assistant-list {
  flex: 1;
  overflow-y: auto;
  padding: 14px;
  background: #fff;
  border: 1px solid #e6ebf2;
  border-radius: 14px;
}
.empty {
  height: 100%;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 14px;
}
.empty-title {
  color: #8492a6;
  font-size: 14px;
}
.starters {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  justify-content: center;
  max-width: 640px;
}
.turn {
  display: flex;
  flex-direction: column;
  margin-bottom: 14px;
}
.turn.user {
  align-items: flex-end;
}
.who {
  font-size: 12px;
  color: #8492a6;
  margin-bottom: 4px;
}
.bubble {
  max-width: 86%;
  padding: 10px 13px;
  border-radius: 12px;
  font-size: 14px;
  line-height: 1.7;
  background: #f4f7fb;
  color: #1f2733;
}
.turn.user .bubble {
  background: #2f7fe0;
  color: #fff;
}
.text {
  white-space: pre-wrap;
  word-break: break-word;
}
.typing {
  color: #8492a6;
}
.err {
  margin-top: 8px;
}
.assistant-input {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.shots {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}
.shot {
  position: relative;
  width: 86px;
  height: 62px;
  border: 1px solid #e6ebf2;
  border-radius: 8px;
  overflow: hidden;
  background: #f7f9fc;
}
.shot img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}
.shot-x {
  position: absolute;
  top: 2px;
  right: 2px;
  border: 0;
  background: rgba(0, 0, 0, 0.55);
  color: #fff;
  border-radius: 50%;
  width: 18px;
  height: 18px;
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  font-size: 11px;
}
.shot-loading {
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 12px;
  color: #8492a6;
}
.actions {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}
.actions .left {
  display: flex;
  align-items: center;
  gap: 10px;
}
.tip {
  font-size: 12px;
  color: #8492a6;
}
.hidden-file {
  display: none;
}
</style>
