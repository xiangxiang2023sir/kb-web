<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { ElMessage } from 'element-plus'
import { adminApi } from '@/api/endpoints'
import type { HealthIssue } from '@/types'
import { healthTypeLabels } from '@/utils/labels'

const list = ref<HealthIssue[]>([])
const loading = ref(false)
const running = ref(false)

async function load() {
  loading.value = true
  try {
    list.value = await adminApi.healthIssues()
  } finally {
    loading.value = false
  }
}

onMounted(load)

async function run() {
  running.value = true
  try {
    await adminApi.runHealth()
    await load()
    ElMessage.success('检查完成')
  } catch {
    ElMessage.error('检查失败，请重试')
  } finally {
    running.value = false
  }
}

const typeTag = (t: HealthIssue['type']) =>
  t === 'dead_link' ? 'danger' : t === 'orphan_reference' ? 'warning' : ('info' as const)
</script>

<template>
  <div class="page-card">
    <div class="filter-bar">
      <el-button type="primary" :loading="running" @click="run">重新检查</el-button>
      <span class="hint">检查范围：死链、引用完整性、格式规范</span>
    </div>

    <el-skeleton v-if="loading && !list.length" :rows="5" animated />
    <el-table v-else v-loading="loading" :data="list" empty-text="暂无问题，知识库状态良好">
      <el-table-column label="类型" width="120">
        <template #default="{ row }">
          <el-tag size="small" :type="typeTag(row.type)">
            {{ healthTypeLabels[row.type as keyof typeof healthTypeLabels] }}
          </el-tag>
        </template>
      </el-table-column>
      <el-table-column prop="docTitle" label="文档" min-width="200" show-overflow-tooltip />
      <el-table-column prop="detail" label="详情" min-width="280" show-overflow-tooltip />
      <el-table-column label="操作" width="120">
        <template #default="{ row }">
          <el-button size="small" @click="$router.push(`/admin/docs/${row.docId}`)">查看文档</el-button>
        </template>
      </el-table-column>
    </el-table>
  </div>
</template>

<style scoped>
.hint {
  color: var(--kb-text-secondary);
  font-size: 13px;
  align-self: center;
}
</style>
