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

function openBind() {
  bindVisible.value = true
  if (!bindCode.value || bindLeft.value <= 0) void issueBind()
}

async function issueBind() {
  bindLoading.value = true
  try {
    const r = await chatApi.bindFeishuCode()
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
          绑定飞书
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

    <el-dialog v-model="bindVisible" title="绑定飞书" width="420px">
      <p class="bind-hint">在飞书里找到知识库机器人，把下面整句发给它。验证码 5 分钟内有效。</p>
      <div v-if="bindCode" class="bind-code">{{ bindPhrase }}</div>
      <p v-if="bindLeft > 0" class="bind-ttl">剩余 {{ bindLeft }} 秒</p>
      <p v-else-if="bindCode" class="bind-ttl">已过期，请重新生成</p>
      <template #footer>
        <el-button :loading="bindLoading" @click="issueBind">重新生成</el-button>
        <el-button type="primary" :disabled="!bindPhrase || bindLeft <= 0" @click="copyBind">复制</el-button>
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
