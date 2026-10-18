<script setup lang="ts">
import { ref } from 'vue'
import { ElMessage, type UploadFile, type UploadInstance, type UploadRawFile } from 'element-plus'
import { UploadFilled } from '@element-plus/icons-vue'
import { adminApi } from '@/api/endpoints'
import type { UploadResult } from '@/types'
import { fieldLabels, sensitivityLabels } from '@/utils/labels'

const ACCEPT = '.pdf,.docx,.xlsx,.xls,.md,.txt'
const ALLOWED = new Set(ACCEPT.split(','))

const uploadRef = ref<UploadInstance>()
const file = ref<UploadRawFile | null>(null)
const uploading = ref(false)
const results = ref<UploadResult[]>([])

function extOf(name: string) {
  const i = name.lastIndexOf('.')
  return i >= 0 ? name.slice(i).toLowerCase() : ''
}

function onRemove() {
  file.value = null
}

function onChange(f: UploadFile) {
  const raw = (f.raw as UploadRawFile) ?? null
  if (raw && !ALLOWED.has(extOf(raw.name))) {
    ElMessage.warning('只支持 PDF、Word（.docx）、Excel（.xlsx / .xls）、Markdown、TXT')
    file.value = null
    uploadRef.value?.clearFiles()
    return
  }
  file.value = raw
}

async function doUpload() {
  if (!file.value) {
    ElMessage.warning('请先选择文件')
    return
  }
  if (!ALLOWED.has(extOf(file.value.name))) {
    ElMessage.warning('只支持 PDF、Word（.docx）、Excel（.xlsx / .xls）、Markdown、TXT')
    return
  }
  uploading.value = true
  try {
    const r = await adminApi.upload(file.value)
    results.value.unshift(r)
    file.value = null
    uploadRef.value?.clearFiles()
    ElMessage.success('上传成功，已加入待确认队列')
  } catch (err) {
    const ax = err as { response?: { data?: { message?: string } } }
    ElMessage.error(ax.response?.data?.message || '上传失败，请重试')
  } finally {
    uploading.value = false
  }
}
</script>

<template>
  <div class="page-card">
    <el-alert
      type="info"
      :closable="false"
      show-icon
      title="上传后由 Hermes 自动分类，人工确认后才真正入库"
      style="margin-bottom: 16px"
    />

    <el-upload
      drag
      :auto-upload="false"
      :multiple="false"
      :limit="1"
      ref="uploadRef"
      :accept="ACCEPT"
      :on-change="onChange"
      :on-remove="onRemove"
    >
      <el-icon size="40"><UploadFilled /></el-icon>
      <div class="el-upload__text">拖拽文件到此处，或 <em>点击选择</em></div>
      <template #tip>
        <div class="el-upload__tip">仅支持 PDF、Word（.docx）、Excel（.xlsx / .xls）、Markdown、TXT。旧版 .doc、PPT、图片、压缩包不能入库。</div>
      </template>
    </el-upload>

    <div style="margin-top: 14px">
      <el-button type="primary" :loading="uploading" :disabled="!file" @click="doUpload">开始上传</el-button>
    </div>

    <template v-if="results.length">
      <h3>本次上传</h3>
      <el-table :data="results">
        <el-table-column prop="title" label="标题" min-width="220" show-overflow-tooltip />
        <el-table-column label="建议领域" width="120">
          <template #default="{ row }">{{ fieldLabels[row.suggestedField as keyof typeof fieldLabels] }}</template>
        </el-table-column>
        <el-table-column label="建议密级" width="120">
          <template #default="{ row }">{{ sensitivityLabels[row.suggestedSensitivity as keyof typeof sensitivityLabels] }}</template>
        </el-table-column>
        <el-table-column width="140">
          <template #default>
            <el-button size="small" @click="$router.push('/admin/docs/review')">去确认</el-button>
          </template>
        </el-table-column>
      </el-table>
    </template>
  </div>
</template>

<style scoped>
h3 {
  margin: 24px 0 10px;
}
</style>
