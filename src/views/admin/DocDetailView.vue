<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { useRoute } from 'vue-router'
import { adminApi } from '@/api/endpoints'
import type { DocDetail } from '@/types'
import { docStatusLabels, fieldLabels, formatTime, sensitivityLabels } from '@/utils/labels'

const route = useRoute()
const doc = ref<DocDetail | null>(null)

onMounted(async () => {
  doc.value = await adminApi.doc(String(route.params.id))
})
</script>

<template>
  <div v-if="doc" class="page-card">
    <el-descriptions :column="2" border>
      <el-descriptions-item label="标题">{{ doc.title }}</el-descriptions-item>
      <el-descriptions-item label="状态">{{ docStatusLabels[doc.status] }}</el-descriptions-item>
      <el-descriptions-item label="领域">{{ fieldLabels[doc.field] }}</el-descriptions-item>
      <el-descriptions-item label="密级">{{ sensitivityLabels[doc.sensitivity] }}</el-descriptions-item>
      <el-descriptions-item label="更新时间">{{ formatTime(doc.updatedAt) }}</el-descriptions-item>
      <el-descriptions-item v-if="doc.status === 'rejected'" label="驳回原因" :span="2">
        <span style="color: #d9453d">{{ doc.rejectReason || '（未填写）' }}</span>
      </el-descriptions-item>
      <el-descriptions-item label="原件">
        <el-link v-if="doc.hasOriginal" type="primary" :href="`/api/admin/docs/${doc.id}/original`" target="_blank">
          下载原件
        </el-link>
        <span v-else style="color: #8492a6">未留存（早期入库或从 GBrain 同步）</span>
      </el-descriptions-item>
    </el-descriptions>

    <h3>内容</h3>
    <div class="doc-content">{{ doc.content }}</div>

    <template v-if="doc.referencedBy.length">
      <h3>被以下对话引用</h3>
      <el-table :data="doc.referencedBy">
        <el-table-column prop="question" label="问题" min-width="240" show-overflow-tooltip />
        <el-table-column label="时间" width="180">
          <template #default="{ row }">{{ formatTime(row.askedAt) }}</template>
        </el-table-column>
      </el-table>
    </template>
  </div>
</template>

<style scoped>
h3 {
  margin: 20px 0 10px;
}

.doc-content {
  white-space: pre-wrap;
  background: #f7f8fa;
  border: 1px solid var(--kb-border);
  border-radius: 6px;
  padding: 14px;
  line-height: 1.7;
}
</style>
