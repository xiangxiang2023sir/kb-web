<script setup lang="ts">
import { computed, onMounted, onUnmounted, reactive } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useAuthStore } from '@/stores/auth'
import { adminApi } from '@/api/endpoints'
import { wsClient } from '@/api/ws'
import { roleLabels } from '@/utils/labels'
import {
  Odometer,
  Document,
  UploadFilled,
  Finished,
  CircleCheck,
  QuestionFilled,
  User,
  ChatDotRound,
  ChatLineRound,
  SwitchButton,
  Collection,
  FolderOpened,
} from '@element-plus/icons-vue'

const badge = reactive({ pendingDocs: 0, unassignedQuestions: 0, failedChecks: 0 })
let badgeTimer: ReturnType<typeof setInterval> | undefined
async function refreshBadge() {
  try {
    const o = await adminApi.overview()
    badge.pendingDocs = o.pendingDocs ?? 0
    badge.unassignedQuestions = o.unassignedQuestions ?? 0
    badge.failedChecks = o.failedChecks ?? 0
    // 浏览器标签也带红点数字（像微信那样）
    const n = badge.pendingDocs + badge.unassignedQuestions
    document.title = n > 0 ? `(${n}) 工业知识库 · 管理端` : '工业知识库 · 管理端'
  } catch {
    /* 后台轮询失败不打扰 */
  }
}
onMounted(() => {
  void refreshBadge()
  badgeTimer = setInterval(refreshBadge, 30000)
})
onUnmounted(() => {
  if (badgeTimer) clearInterval(badgeTimer)
  document.title = '工业知识库 · 管理端'
})

const route = useRoute()
const router = useRouter()
const auth = useAuthStore()

const title = computed(() => (route.meta.title as string) ?? '')

async function logout() {
  wsClient.disconnect()
  await auth.logout()
  router.push({ name: 'login' })
}
</script>

<template>
  <div class="app-shell">
    <aside class="app-sidebar">
      <div class="logo">工业知识库 · 管理端</div>
      <el-menu :default-active="route.path" router>
        <el-menu-item index="/admin">
          <el-icon><Odometer /></el-icon>
          <span>总览</span>
        </el-menu-item>
        <el-menu-item-group title="知识管理">
          <el-menu-item v-if="auth.isAdmin" index="/admin/kb">
            <el-icon><Collection /></el-icon>
            <span>资料库</span>
          </el-menu-item>
          <el-menu-item v-if="auth.isAdmin" index="/admin/projects">
            <el-icon><FolderOpened /></el-icon>
            <span>项目管理</span>
          </el-menu-item>
          <el-menu-item index="/admin/docs">
            <el-icon><Document /></el-icon>
            <el-badge :value="badge.pendingDocs" :hidden="!badge.pendingDocs" :max="99" class="menu-badge"><span>文档列表</span></el-badge>
          </el-menu-item>
          <el-menu-item index="/admin/docs/upload">
            <el-icon><UploadFilled /></el-icon>
            <span>上传文档</span>
          </el-menu-item>
        </el-menu-item-group>
        <el-menu-item index="/admin/health">
          <el-icon><CircleCheck /></el-icon>
          <el-badge :value="badge.failedChecks" :hidden="!badge.failedChecks" :max="99" class="menu-badge"><span>健康检查</span></el-badge>
        </el-menu-item>
        <el-menu-item index="/admin/questions">
          <el-icon><QuestionFilled /></el-icon>
          <el-badge :value="badge.unassignedQuestions" :hidden="!badge.unassignedQuestions" :max="99" class="menu-badge"><span>问题队列</span></el-badge>
        </el-menu-item>
        <el-menu-item index="/admin/assistant">
          <el-icon><ChatLineRound /></el-icon>
          <span>AI知识库管理助手</span>
        </el-menu-item>
        <el-menu-item v-if="auth.isAdmin" index="/admin/users">
          <el-icon><User /></el-icon>
          <span>用户管理</span>
        </el-menu-item>
      </el-menu>
      <div class="sidebar-footer">
        <div class="user-chip">{{ auth.user?.name }} · {{ auth.user ? roleLabels[auth.user.role] : '' }}</div>
        <el-button text :icon="ChatDotRound" @click="router.push('/chat')">返回对话端</el-button>
        <el-button text :icon="SwitchButton" @click="logout">退出登录</el-button>
      </div>
    </aside>
    <div class="app-main">
      <header class="app-topbar">
        <span class="page-title">{{ title }}</span>
      </header>
      <main class="app-content">
        <router-view />
      </main>
    </div>
  </div>
</template>

<style scoped>
.menu-badge {
  margin-left: 6px;
}
.menu-badge :deep(.el-badge__content) {
  position: static;
  transform: none;
  margin-left: 4px;
}
</style>
