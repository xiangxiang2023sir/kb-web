<script setup lang="ts">
import { computed } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useAuthStore } from '@/stores/auth'
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
  SwitchButton,
} from '@element-plus/icons-vue'

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
          <el-menu-item index="/admin/docs">
            <el-icon><Document /></el-icon>
            <span>文档列表</span>
          </el-menu-item>
          <el-menu-item index="/admin/docs/upload">
            <el-icon><UploadFilled /></el-icon>
            <span>上传文档</span>
          </el-menu-item>
          <el-menu-item index="/admin/docs/review">
            <el-icon><Finished /></el-icon>
            <span>待确认</span>
          </el-menu-item>
        </el-menu-item-group>
        <el-menu-item index="/admin/health">
          <el-icon><CircleCheck /></el-icon>
          <span>健康检查</span>
        </el-menu-item>
        <el-menu-item index="/admin/questions">
          <el-icon><QuestionFilled /></el-icon>
          <span>问题队列</span>
        </el-menu-item>
        <el-menu-item v-if="auth.user?.role === 'owner'" index="/admin/users">
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
