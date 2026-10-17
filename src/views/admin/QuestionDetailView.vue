<script setup lang="ts">
import { onMounted, reactive, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ElMessage } from 'element-plus'
import { adminApi } from '@/api/endpoints'
import type { Field, QuestionDetail, Sensitivity } from '@/types'
import { fieldLabels, formatTime, questionStatusLabels, sensitivityLabels } from '@/utils/labels'

const route = useRoute()
const router = useRouter()

const q = ref<QuestionDetail | null>(null)
const saving = ref(false)

const form = reactive<{ answer: string; title: string; field: Field; sensitivity: Sensitivity }>({
  answer: '',
  title: '',
  field: 'electrical',
  sensitivity: 'internal',
})

onMounted(async () => {
  q.value = await adminApi.question(String(route.params.id))
  form.title = q.value.question.slice(0, 30)
  form.field = q.value.field
})

async function submit() {
  if (!q.value) return
  if (!form.title.trim() || !form.answer.trim()) {
    ElMessage.warning('请填写知识标题和解答')
    return
  }
  saving.value = true
  try {
    await adminApi.resolveQuestion(q.value.id, { ...form })
    ElMessage.success('已解决，知识进入待确认队列')
    router.push({ name: 'admin-questions' })
  } catch {
    ElMessage.error('提交失败，请重试')
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <div v-if="q" class="page-card">
    <el-descriptions :column="2" border>
      <el-descriptions-item label="问题" :span="2">{{ q.question }}</el-descriptions-item>
      <el-descriptions-item label="提问人">{{ q.askedBy }}</el-descriptions-item>
      <el-descriptions-item label="领域">{{ fieldLabels[q.field] }}</el-descriptions-item>
      <el-descriptions-item label="状态">{{ questionStatusLabels[q.status] }}</el-descriptions-item>
      <el-descriptions-item label="时间">{{ formatTime(q.createdAt) }}</el-descriptions-item>
    </el-descriptions>

    <template v-if="q.context">
      <h3>对话上下文</h3>
      <div class="context">{{ q.context }}</div>
    </template>

    <h3>解答并入库</h3>
    <el-alert
      type="info"
      :closable="false"
      show-icon
      title="提交后由 Hermes 自动分类，知识进入待确认队列，确认后入库"
      style="margin-bottom: 14px"
    />
    <el-form label-width="80px">
      <el-form-item label="知识标题">
        <el-input v-model="form.title" maxlength="60" show-word-limit />
      </el-form-item>
      <el-form-item label="领域">
        <el-select v-model="form.field" style="width: 200px">
          <el-option v-for="(label, v) in fieldLabels" :key="v" :label="label" :value="v" />
        </el-select>
      </el-form-item>
      <el-form-item label="密级">
        <el-select v-model="form.sensitivity" style="width: 200px">
          <el-option v-for="(label, v) in sensitivityLabels" :key="v" :label="label" :value="v" />
        </el-select>
      </el-form-item>
      <el-form-item label="解答">
        <el-input v-model="form.answer" type="textarea" :rows="8" placeholder="给出可复用的标准解答，入库后其他工程师也能检索到" />
      </el-form-item>
      <el-form-item>
        <el-button type="primary" :loading="saving" @click="submit">解决并入库</el-button>
      </el-form-item>
    </el-form>
  </div>
</template>

<style scoped>
h3 {
  margin: 20px 0 10px;
}

.context {
  white-space: pre-wrap;
  background: #f7f8fa;
  border: 1px solid var(--kb-border);
  border-radius: 6px;
  padding: 14px;
  line-height: 1.7;
}
</style>
