<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { adminApi } from '@/api/endpoints'
import type { AdminOverview } from '@/types'

const overview = ref<AdminOverview | null>(null)

onMounted(async () => {
  overview.value = await adminApi.overview()
})
</script>

<template>
  <el-skeleton v-if="!overview" :rows="3" animated />
  <div v-else class="stat-grid">
    <el-card shadow="never" class="stat" @click="$router.push('/admin/docs/review')">
      <div class="num" :class="{ warn: overview.pendingDocs > 0 }">{{ overview.pendingDocs }}</div>
      <div class="label">待确认文档</div>
    </el-card>
    <el-card shadow="never" class="stat" @click="$router.push('/admin/questions')">
      <div class="num" :class="{ warn: overview.unassignedQuestions > 0 }">{{ overview.unassignedQuestions }}</div>
      <div class="label">未分配问题</div>
    </el-card>
    <el-card shadow="never" class="stat" @click="$router.push('/admin/health')">
      <div class="num" :class="{ danger: overview.failedChecks > 0 }">{{ overview.failedChecks }}</div>
      <div class="label">健康检查未通过</div>
    </el-card>
    <el-card shadow="never" class="stat">
      <div class="num">{{ overview.todayQuestions }}</div>
      <div class="label">今日提问</div>
    </el-card>
  </div>
</template>

<style scoped>
.stat-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
  gap: 16px;
}

.stat {
  cursor: pointer;
}

.num {
  font-size: 32px;
  font-weight: 600;
}

.num.warn {
  color: var(--el-color-warning);
}

.num.danger {
  color: var(--el-color-danger);
}

.label {
  margin-top: 6px;
  color: var(--kb-text-secondary);
}
</style>
