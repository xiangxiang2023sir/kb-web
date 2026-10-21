<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ElMessage, ElMessageBox } from 'element-plus'
import { useAuthStore } from '@/stores/auth'
import { useChatStore } from '@/stores/chat'
import { chatApi } from '@/api/endpoints'
import { wsClient } from '@/api/ws'
import { roleLabels } from '@/utils/labels'
import { ChatDotRound, Clock, Connection, Menu, QuestionFilled, Setting, SwitchButton } from '@element-plus/icons-vue'

const route = useRoute()
const router = useRouter()
const auth = useAuthStore()
const chat = useChatStore()

onMounted(() => chat.init())

const navOpen = ref(false)
watch(
  () => route.fullPath,
  () => {
    navOpen.value = false
  },
)

function closeNav() {
  navOpen.value = false
}

const activeMenu = computed(() => {
  const p = route.path
  if (p.startsWith('/chat/history')) return '/chat/history'
  if (p.startsWith('/chat/unanswered')) return '/chat/unanswered'
  return '/chat'
})

function newChat() {
  chat.reset()
  navOpen.value = false
  if (route.path !== '/chat') router.push('/chat')
}

async function logout() {
  wsClient.disconnect()
  await auth.logout()
  router.push({ name: 'login' })
}

const bindVisible = ref(false)
const skillLoading = ref(false)
const skillCreatedAt = ref<string | null>(null)

const skillTimeText = computed(() => {
  if (!skillCreatedAt.value) return ''
  try {
    return new Date(skillCreatedAt.value).toLocaleString('zh-CN')
  } catch {
    return skillCreatedAt.value
  }
})

async function loadSkillMeta() {
  try {
    const r = await chatApi.skillMeta()
    skillCreatedAt.value = r.createdAt
  } catch {
    skillCreatedAt.value = null
  }
}

function openBind() {
  navOpen.value = false
  bindVisible.value = true
  void loadSkillMeta()
}

function saveSkillFile(filename: string, markdown: string) {
  const blob = new Blob([markdown], { type: 'text/markdown;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  URL.revokeObjectURL(url)
}

async function downloadSkill() {
  if (skillCreatedAt.value) {
    try {
      await ElMessageBox.confirm('下载新的 Skill 会让旧文件立刻失效。还没交给智能体的旧说明也不能再用。', '更换钥匙', {
        type: 'warning',
        confirmButtonText: '下载新的',
        cancelButtonText: '取消',
      })
    } catch {
      return
    }
  }
  skillLoading.value = true
  try {
    const r = await chatApi.downloadSkill()
    saveSkillFile(r.filename, r.markdown)
    skillCreatedAt.value = r.createdAt
    ElMessage.success('已下载 kb-web.SKILL.md，交给飞书智能体 / 豆包 / Cursor 即可')
  } catch (err) {
    const msg = (err as { response?: { data?: { message?: string } } })?.response?.data?.message || '下载失败'
    ElMessage.error(msg)
  } finally {
    skillLoading.value = false
  }
}

async function revokeSkill() {
  try {
    await ElMessageBox.confirm('作废后，已经交给智能体的那份 Skill 立刻不能检索。', '作废钥匙', {
      type: 'warning',
      confirmButtonText: '作废',
      cancelButtonText: '取消',
    })
  } catch {
    return
  }
  skillLoading.value = true
  try {
    await chatApi.revokeSkill()
    skillCreatedAt.value = null
    ElMessage.success('已作废')
  } catch {
    ElMessage.error('作废失败')
  } finally {
    skillLoading.value = false
  }
}
</script>

<template>
  <div class="app-shell chat-shell">
    <header class="chat-mobile-bar">
      <button type="button" class="chat-nav-btn" aria-label="打开菜单" @click="navOpen = true">
        <el-icon :size="20"><Menu /></el-icon>
      </button>
      <span class="chat-mobile-title">工业知识库</span>
      <button type="button" class="chat-nav-btn" aria-label="新对话" @click="newChat">新对话</button>
    </header>
    <button v-if="navOpen" type="button" class="chat-nav-mask" aria-label="关闭菜单" @click="closeNav" />
    <aside class="app-sidebar" :class="{ open: navOpen }">
      <div class="logo">工业知识库</div>
      <el-menu :default-active="activeMenu" router @select="closeNav">
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

    <el-dialog v-model="bindVisible" title="绑定外部 agent" class="chat-bind-dialog" width="min(480px, 92vw)">
      <p class="bind-hint">
        下载一份 Skill 说明（含你的钥匙），交给飞书智能体、豆包或 Cursor。问设备、规程时它会调知识库，把现成答案原样发给你，不自己发挥。一个账号一把钥匙。
      </p>
      <p v-if="skillTimeText" class="bind-ttl">当前钥匙生成于 {{ skillTimeText }}。再下载会作废旧文件。</p>
      <p v-else class="bind-ttl">还没有钥匙，下载即生成。</p>
      <template #footer>
        <el-button :disabled="!skillCreatedAt" :loading="skillLoading" @click="revokeSkill">作废钥匙</el-button>
        <el-button type="primary" :loading="skillLoading" @click="downloadSkill">下载 Skill.md</el-button>
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

.bind-ttl {
  margin: 10px 0 0;
  color: var(--kb-text-secondary);
  font-size: 13px;
}
</style>
