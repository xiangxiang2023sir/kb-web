<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { ElMessage } from 'element-plus'
import { adminApi } from '@/api/endpoints'
import type { HealthIssue, HealthSummary } from '@/types'
import { healthTypeLabels, healthTypeTag } from '@/utils/labels'

const list = ref<HealthIssue[]>([])
const summary = ref<HealthSummary | null>(null)
const loading = ref(false)
const running = ref(false)

const summaryText = computed(() => {
  const s = summary.value
  if (!s) return ''
  const parts = [
    `台账 ${s.ledgerPages} 页`,
    `正文在台账 ${s.bodyInSqlite}`,
    `正文仅 GBrain ${s.bodyInGbrainOnly}（已跳过 frontmatter）`,
  ]
  if (s.gbrainPages != null) parts.push(`GBrain ${s.gbrainPages} 页`)
  if (s.missingInGbrain) parts.push(`台账有库无 ${s.missingInGbrain}`)
  if (s.missingInLedger) parts.push(`库有台账无 ${s.missingInLedger}`)
  return parts.join(' · ')
})

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
    const r = await adminApi.runHealth()
    summary.value = r.summary
    await load()
    ElMessage.success(`检查完成，${r.issueCount} 条问题`)
  } catch {
    ElMessage.error('检查失败，请重试')
  } finally {
    running.value = false
  }
}

function canOpenDoc(row: HealthIssue) {
  return Boolean(row.docId) && !String(row.docId).startsWith('_')
}
</script>

<template>
  <div class="page-card">
    <div class="filter-bar">
      <el-button type="primary" :loading="running" @click="run">重新检查</el-button>
      <span class="hint">空正文不再报缺少 frontmatter；对照台账与 GBrain；有副本才验格式/死链</span>
    </div>
    <p v-if="summaryText" class="summary">{{ summaryText }}</p>

    <el-skeleton v-if="loading && !list.length" :rows="5" animated />
    <el-table v-else v-loading="loading" :data="list" empty-text="暂无问题，知识库状态良好">
      <el-table-column label="类型" width="120">
        <template #default="{ row }">
          <el-tag size="small" :type="healthTypeTag(row.type)">
            {{ healthTypeLabels[row.type as keyof typeof healthTypeLabels] }}
          </el-tag>
        </template>
      </el-table-column>
      <el-table-column prop="docTitle" label="文档" min-width="200" show-overflow-tooltip />
      <el-table-column prop="detail" label="详情" min-width="280" show-overflow-tooltip />
      <el-table-column label="操作" width="120">
        <template #default="{ row }">
          <el-button v-if="canOpenDoc(row)" size="small" @click="$router.push(`/admin/docs/${row.docId}`)">
            查看文档
          </el-button>
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

.summary {
  margin: 0 0 12px;
  font-size: 13px;
  color: var(--kb-text-secondary);
  line-height: 1.5;
}
</style>
