<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { questionApi } from '@/api/endpoints'
import type { QuestionItem, QuestionStatus } from '@/types'
import { fieldLabels, questionStatusLabels, formatTime } from '@/utils/labels'

const list = ref<QuestionItem[]>([])
const loading = ref(false)

onMounted(async () => {
  loading.value = true
  try {
    list.value = await questionApi.mine()
  } finally {
    loading.value = false
  }
})

const statusTag = (s: QuestionStatus) =>
  s === 'resolved' ? 'success' : s === 'assigned' ? 'warning' : ('info' as const)
</script>

<template>
  <div class="app-content">
    <div class="page-card">
      <el-skeleton v-if="loading && !list.length" :rows="5" animated />
      <el-table v-else v-loading="loading" :data="list" empty-text="暂无转入队列的问题">
        <el-table-column prop="question" label="问题" min-width="280" show-overflow-tooltip />
        <el-table-column label="领域" width="100">
          <template #default="{ row }">{{ fieldLabels[row.field as keyof typeof fieldLabels] }}</template>
        </el-table-column>
        <el-table-column label="状态" width="110">
          <template #default="{ row }">
            <el-tag size="small" :type="statusTag(row.status)">
              {{ questionStatusLabels[row.status as keyof typeof questionStatusLabels] }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="提交时间" width="180">
          <template #default="{ row }">{{ formatTime(row.createdAt) }}</template>
        </el-table-column>
      </el-table>
    </div>
  </div>
</template>
