<script setup lang="ts">
import { onMounted, reactive, ref } from 'vue'
import { useRouter } from 'vue-router'
import { ElMessage } from 'element-plus'
import { adminApi } from '@/api/endpoints'
import type { Field, QuestionItem, QuestionStatus, User } from '@/types'
import { fieldLabels, formatTime, questionStatusLabels, roleLabels } from '@/utils/labels'

const router = useRouter()
const list = ref<QuestionItem[]>([])
const users = ref<User[]>([])
const loading = ref(false)

const query = reactive<{ field?: Field; status?: QuestionStatus }>({})

async function load() {
  loading.value = true
  try {
    list.value = await adminApi.questions(query)
  } finally {
    loading.value = false
  }
}

onMounted(async () => {
  await load()
  users.value = await adminApi.users()
})

const assignVisible = ref(false)
const current = ref<QuestionItem | null>(null)
const assigneeId = ref('')

function openAssign(row: QuestionItem) {
  current.value = row
  assigneeId.value = ''
  assignVisible.value = true
}

async function doAssign() {
  if (!current.value || !assigneeId.value) return
  try {
    await adminApi.assignQuestion(current.value.id, assigneeId.value)
    ElMessage.success('已指派')
    assignVisible.value = false
    void load()
  } catch {
    ElMessage.error('指派失败，请重试')
  }
}

const statusTag = (s: QuestionStatus) =>
  s === 'resolved' ? 'success' : s === 'assigned' ? 'warning' : ('info' as const)
</script>

<template>
  <div class="page-card">
    <div class="filter-bar">
      <el-select v-model="query.field" placeholder="领域" clearable style="width: 130px" @change="load">
        <el-option v-for="(label, v) in fieldLabels" :key="v" :label="label" :value="v" />
      </el-select>
      <el-select v-model="query.status" placeholder="状态" clearable style="width: 130px" @change="load">
        <el-option v-for="(label, v) in questionStatusLabels" :key="v" :label="label" :value="v" />
      </el-select>
    </div>

    <el-table v-loading="loading" :data="list" empty-text="暂无问题">
      <el-table-column prop="question" label="问题" min-width="260" show-overflow-tooltip />
      <el-table-column prop="askedBy" label="提问人" width="100" />
      <el-table-column label="领域" width="90">
        <template #default="{ row }">{{ fieldLabels[row.field as Field] }}</template>
      </el-table-column>
      <el-table-column label="状态" width="100">
        <template #default="{ row }">
          <el-tag size="small" :type="statusTag(row.status)">{{ questionStatusLabels[row.status as QuestionStatus] }}</el-tag>
        </template>
      </el-table-column>
      <el-table-column prop="assignee" label="责任人" width="100">
        <template #default="{ row }">{{ row.assignee || '—' }}</template>
      </el-table-column>
      <el-table-column label="时间" width="170">
        <template #default="{ row }">{{ formatTime(row.createdAt) }}</template>
      </el-table-column>
      <el-table-column label="操作" width="180">
        <template #default="{ row }">
          <el-button size="small" @click="router.push(`/admin/questions/${row.id}`)">详情</el-button>
          <el-button size="small" type="primary" plain :disabled="row.status === 'resolved'" @click="openAssign(row)">
            指派
          </el-button>
        </template>
      </el-table-column>
    </el-table>

    <el-dialog v-model="assignVisible" title="指派责任人" width="380px">
      <el-select v-model="assigneeId" placeholder="选择责任人" style="width: 100%">
        <el-option
          v-for="u in users"
          :key="u.id"
          :label="`${u.name}（${roleLabels[u.role]}${u.field ? ' · ' + fieldLabels[u.field] : ''}）`"
          :value="u.id"
        />
      </el-select>
      <template #footer>
        <el-button @click="assignVisible = false">取消</el-button>
        <el-button type="primary" :disabled="!assigneeId" @click="doAssign">指派</el-button>
      </template>
    </el-dialog>
  </div>
</template>
