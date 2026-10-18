<script setup lang="ts">
import { useRouter } from 'vue-router'
import { useAuthStore } from '@/stores/auth'

const router = useRouter()
const auth = useAuthStore()
</script>

<template>
  <div class="not-found">
    <el-empty description="没有这个页面">
      <el-button type="primary" @click="router.push(auth.homePath)">返回首页</el-button>
    </el-empty>
  </div>
</template>

<style scoped>
.not-found {
  min-height: 280px;
  display: flex;
  align-items: center;
  justify-content: center;
}
</style>
