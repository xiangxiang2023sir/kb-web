<script setup lang="ts">
import { computed, onMounted } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useAuthStore } from '@/stores/auth'
import { useChatStore } from '@/stores/chat'
import { wsClient } from '@/api/ws'
import { roleLabels } from '@/utils/labels'
import { ChatDotRound, Clock, QuestionFilled, Setting, SwitchButton } from '@element-plus/icons-vue'

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
        <el-button v-if="auth.isAdmin" text :icon="Setting" @click="router.push('/admin')">
          进入管理端
        </el-button>
        <el-button text :icon="SwitchButton" @click="logout">退出登录</el-button>
      </div>
    </aside>
    <div class="app-main">
      <router-view />
    </div>
  </div>
</template>
