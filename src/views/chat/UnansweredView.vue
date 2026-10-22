<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { ElMessage } from 'element-plus'
import { questionApi } from '@/api/endpoints'
import type { QuestionItem, QuestionStatus } from '@/types'
import { fieldLabels, questionStatusLabels, formatTime } from '@/utils/labels'

const list = ref<QuestionItem[]>([])
const loading = ref(false)
const open = ref(false)
const draft = ref('')
const saving = ref(false)

async function load() {
  loading.value = true
  try {
    list.value = await questionApi.mine()
  } finally {
    loading.value = false
  }
}

function showNew() {
  draft.value = ''
  open.value = true
}

async function submit() {
  const question = draft.value.trim()
  if (!question) {
    ElMessage.warning('请填写问题')
    return
  }
  saving.value = true
  try {
    await questionApi.submit(question)
    open.value = false
    ElMessage.success('已转入问题队列')
    await load()
  } catch {
    ElMessage.error('提交失败，请重试')
  } finally {
    saving.value = false
  }
}

onMounted(() => {
  void load()
})

const statusTag = (s: QuestionStatus) =>
  s === 'resolved' ? 'success' : s === 'assigned' ? 'warning' : ('info' as const)
</script>

<template>
  <div class="app-content">
    <div class="page-card">
      <div class="card-head">
        <el-button type="primary" @click="showNew">新增问题</el-button>
      </div>
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

    <el-dialog v-model="open" title="新增问题" width="480px">
      <el-input v-model="draft" type="textarea" :rows="4" maxlength="500" show-word-limit placeholder="写下要交给责任人解答的问题" />
      <template #footer>
        <el-button @click="open = false">取消</el-button>
        <el-button type="primary" :loading="saving" @click="submit">提交</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<style scoped>
.card-head {
  display: flex;
  justify-content: flex-end;
  margin-bottom: 12px;
}
</style>
