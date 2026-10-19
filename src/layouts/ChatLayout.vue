<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ElMessage } from 'element-plus'
import { useAuthStore } from '@/stores/auth'
import { useChatStore } from '@/stores/chat'
import { chatApi } from '@/api/endpoints'
import { wsClient } from '@/api/ws'
import { roleLabels } from '@/utils/labels'
import { ChatDotRound, Clock, Connection, QuestionFilled, Setting, SwitchButton } from '@element-plus/icons-vue'

const route = useRoute()
const router = useRouter()
const auth = useAuthStore()
const chat = useChatStore()

onMounted(() => chat.init())

const activeMenu = computed(() => {
  const p = route.path
  if (p.startsWith('/chat/history')) return '/chat/history'
  if (p.startsWith('/chat/unanswered')) return '/chat/unanswered'
  return '/chat'
})

function newChat() {
  chat.reset()
  if (route.path !== '/chat') router.push('/chat')
}

async function logout() {
  wsClient.disconnect()
  await auth.logout()
  router.push({ name: 'login' })
}

const bindVisible = ref(false)
const bindLoading = ref(false)
const bindCode = ref('')
const bindLeft = ref(0)
let bindTimer: ReturnType<typeof setInterval> | undefined

const bindPhrase = computed(() => (bindCode.value ? `绑定 ${bindCode.value}` : ''))

onUnmounted(() => {
  if (bindTimer) clearInterval(bindTimer)
})

const identities = ref<{ channel: string; externalId: string; boundAt: string }[]>([])
/** 绑定给哪个渠道 / 哪个 agent token */
const bindChannel = ref('feishu')
const channelOptions = [
  { value: 'feishu', label: '飞书智能体' },
  { value: 'teams', label: 'Teams / Copilot' },
  { value: 'doubao', label: '豆包 / 扣子' },
  { value: 'yuanbao', label: '元宝 / 腾讯智能体' },
  { value: 'other', label: '其它' },
]
const kitLoading = ref(false)

async function downloadKit() {
  kitLoading.value = true
  try {
    const r = await chatApi.agentKit({ channel: bindChannel.value, code: bindCode.value })
    const blob = new Blob([r.markdown], { type: 'text/markdown;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = r.filename
    document.body.appendChild(a)
    a.click()
    a.remove()
    URL.revokeObjectURL(url)
    ElMessage.success('接入说明已下载，直接发给那个智能体/平台即可')
  } catch (err) {
    const msg = (err as { response?: { data?: { message?: string } } })?.response?.data?.message || '生成失败（可能没有 agent token）'
    ElMessage.error(msg)
  } finally {
    kitLoading.value = false
  }
}
const bindLoadingIds = ref(false)

async function loadIdentities() {
  bindLoadingIds.value = true
  try {
    identities.value = await chatApi.identities()
  } catch {
    /* 忽略 */
  } finally {
    bindLoadingIds.value = false
  }
}

async function unbind(channel: string, externalId: string) {
  try {
    await chatApi.unbind(channel, externalId)
    ElMessage.success('已解绑')
    void loadIdentities()
  } catch {
    ElMessage.error('解绑失败')
  }
}

function openBind() {
  bindVisible.value = true
  void loadIdentities()
  if (!bindCode.value || bindLeft.value <= 0) void issueBind()
}

async function issueBind() {
  bindLoading.value = true
  try {
    const r = await chatApi.bindCode()
    bindCode.value = r.code
    bindLeft.value = r.expiresIn
    if (bindTimer) clearInterval(bindTimer)
    bindTimer = setInterval(() => {
      bindLeft.value -= 1
      if (bindLeft.value <= 0 && bindTimer) {
        clearInterval(bindTimer)
        bindTimer = undefined
      }
    }, 1000)
  } catch {
    ElMessage.error('生成验证码失败，请重试')
  } finally {
    bindLoading.value = false
  }
}

async function copyBind() {
  if (!bindPhrase.value) return
  try {
    await navigator.clipboard.writeText(bindPhrase.value)
    ElMessage.success('已复制')
  } catch {
    ElMessage.error('复制失败，请手动选中')
  }
}
</script>

<template>
  <div class="app-shell">
    <aside class="app-sidebar">
      <div class="logo">工业知识库</div>
      <el-menu :default-active="activeMenu" router>
        <el-menu-item index="/chat" @click="newChat">
          <el-icon><ChatDotRound /></el-icon>
          <span>新对话</span>
        </el-menu-item>
        <el-menu-item index="/chat/history">
          <el-icon><Clock /></el-icon>
          <span>历史会话</span>
        </el-menu-item>
        <el-menu-item index="/chat/unanswered">
          <el-icon><QuestionFilled /></el-icon>
          <span>未解答问题</span>
        </el-menu-item>
      </el-menu>
      <div class="sidebar-footer">
        <div class="user-chip">{{ auth.user?.name }} · {{ auth.user ? roleLabels[auth.user.role] : '' }}</div>
        <el-button v-if="auth.user && auth.user.role !== 'guest'" text :icon="Connection" @click="openBind">
          绑定外部 agent
        </el-button>
        <el-button v-if="auth.isAdmin" text :icon="Setting" @click="router.push('/admin')">
          进入管理端
        </el-button>
        <el-button text :icon="SwitchButton" @click="logout">退出登录</el-button>
      </div>
    </aside>
    <div class="app-main">
      <router-view />
    </div>

    <el-dialog v-model="bindVisible" title="绑定外部 agent（飞书 / Teams / 豆包…）" width="520px">
      <p class="bind-hint">
        把下面的码发给你的 agent（飞书智能体、Teams 的 Copilot、豆包/扣子…），让它调一次
        <code>POST /api/agent/bind</code>（带它自己的 token，body 里 <code>code</code> 填这个码、
        <code>external_id</code> 填你的身份）。绑好后它就能替你按权限检索知识库。
      </p>
      <div style="margin: 10px 0 6px">
        <span style="font-size: 13px; color: var(--kb-text-secondary); margin-right: 8px">绑定给哪个渠道</span>
        <el-select v-model="bindChannel" size="small" style="width: 200px">
          <el-option v-for="o in channelOptions" :key="o.value" :label="o.label" :value="o.value" />
        </el-select>
      </div>
      <div v-if="bindCode" class="bind-code">{{ bindCode }}</div>
      <p v-if="bindLeft > 0" class="bind-ttl">剩余 {{ bindLeft }} 秒（一次性，用过即作废）</p>
      <p v-else-if="bindCode" class="bind-ttl">已过期，请重新生成</p>

      <div v-loading="bindLoadingIds" style="margin-top: 16px">
        <div style="font-size: 13px; color: var(--kb-text-secondary); margin-bottom: 6px">已绑定</div>
        <el-table v-if="identities.length" :data="identities" size="small">
          <el-table-column prop="channel" label="渠道" width="110" />
          <el-table-column prop="externalId" label="身份" show-overflow-tooltip />
          <el-table-column label="" width="80">
            <template #default="{ row }">
              <el-button size="small" text type="danger" @click="unbind(row.channel, row.externalId)">解绑</el-button>
            </template>
          </el-table-column>
        </el-table>
        <div v-else style="font-size: 13px; color: var(--kb-text-secondary)">还没绑定任何 agent</div>
      </div>

      <template #footer>
        <el-button :loading="bindLoading" @click="issueBind">重新生成</el-button>
        <el-button :disabled="!bindCode || bindLeft <= 0" @click="copyBind">复制绑定码</el-button>
        <el-button type="primary" :loading="kitLoading" @click="downloadKit">下载接入说明 (.md)</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<style scoped>
.bind-hint {
  margin: 0 0 12px;
  color: var(--kb-text-secondary);
  line-height: 1.6;
}

.bind-code {
  font-size: 22px;
  font-weight: 600;
  letter-spacing: 2px;
  text-align: center;
  padding: 16px;
  background: var(--kb-content-bg);
  border: 1px solid var(--kb-border);
  border-radius: 8px;
}

.bind-ttl {
  margin: 10px 0 0;
  text-align: center;
  color: var(--kb-text-secondary);
  font-size: 13px;
}
</style>
