<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { chatApi } from '@/api/endpoints'
import type { Session } from '@/types'
import { formatTime } from '@/utils/labels'

const router = useRouter()
const list = ref<Session[]>([])
const loading = ref(false)

onMounted(async () => {
  loading.value = true
  try {
    list.value = await chatApi.sessions()
  } finally {
    loading.value = false
  }
})

function open(row: Session) {
  router.push(`/chat/${row.id}`)
}
</script>

<template>
  <div class="app-content">
    <div class="page-card">
      <el-table v-loading="loading" :data="list" empty-text="暂无历史会话" @row-click="open">
        <el-table-column prop="title" label="标题" min-width="220" />
        <el-table-column prop="preview" label="最近内容" min-width="280" show-overflow-tooltip />
        <el-table-column label="更新时间" width="180">
          <template #default="{ row }">{{ formatTime(row.updatedAt) }}</template>
        </el-table-column>
      </el-table>
    </div>
  </div>
</template>
