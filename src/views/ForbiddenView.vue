<script setup lang="ts">
import { useRouter } from 'vue-router'
import { useAuthStore } from '@/stores/auth'

const router = useRouter()
const auth = useAuthStore()
</script>

<template>
  <div class="forbidden">
    <h1>403</h1>
    <p>没有访问该页面的权限</p>
    <el-button type="primary" @click="router.push(auth.homePath)">返回首页</el-button>
  </div>
</template>

<style scoped>
.forbidden {
  height: 100vh;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 12px;
  background: var(--kb-content-bg);
}

h1 {
  font-size: 48px;
  margin: 0;
}

p {
  color: var(--kb-text-secondary);
  margin: 0 0 12px;
}
</style>
