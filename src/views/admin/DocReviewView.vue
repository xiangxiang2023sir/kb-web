<script setup lang="ts">
import { onMounted, reactive, ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { adminApi } from '@/api/endpoints'
import type { DocItem, Field, Sensitivity } from '@/types'
import { fieldLabels, sensitivityLabels } from '@/utils/labels'

const list = ref<DocItem[]>([])
const loading = ref(false)

async function load() {
  loading.value = true
  try {
    list.value = (await adminApi.docs({ status: 'pending', size: 100 })).list
  } finally {
    loading.value = false
  }
}

onMounted(load)

const confirmVisible = ref(false)
const current = ref<DocItem | null>(null)
const form = reactive<{ field: Field; sensitivity: Sensitivity }>({
  field: 'electrical',
  sensitivity: 'internal',
})

function openConfirm(row: DocItem) {
  current.value = row
  // 默认采用 Hermes 的建议分类，管理员可修改
  form.field = row.suggestedField ?? row.field
  form.sensitivity = row.suggestedSensitivity ?? row.sensitivity
  confirmVisible.value = true
}

async function doConfirm() {
  if (!current.value) return
  try {
    await adminApi.confirmDoc(current.value.id, form.field, form.sensitivity)
    ElMessage.success('已确认入库')
    confirmVisible.value = false
    void load()
  } catch {
    ElMessage.error('操作失败，请重试')
  }
}

async function doReject(row: DocItem) {
  try {
    const { value } = await ElMessageBox.prompt('请输入驳回原因', '驳回文档', {
      confirmButtonText: '驳回',
      cancelButtonText: '取消',
      inputPlaceholder: '原因',
    })
    await adminApi.rejectDoc(row.id, value || '')
    ElMessage.success('已驳回')
    void load()
  } catch {
    /* 用户取消 */
  }
}
</script>

<template>
  <div class="page-card">
    <el-skeleton v-if="loading && !list.length" :rows="5" animated />
    <el-table v-else v-loading="loading" :data="list" empty-text="没有待确认的文档">
      <el-table-column prop="title" label="标题" min-width="220" show-overflow-tooltip />
      <el-table-column label="建议领域" width="110">
        <template #default="{ row }">
          {{ fieldLabels[(row.suggestedField ?? row.field) as Field] }}
        </template>
      </el-table-column>
      <el-table-column label="建议密级" width="110">
        <template #default="{ row }">
          <el-tag size="small" effect="plain">
            {{ sensitivityLabels[(row.suggestedSensitivity ?? row.sensitivity) as Sensitivity] }}
          </el-tag>
        </template>
      </el-table-column>
      <el-table-column label="操作" width="180">
        <template #default="{ row }">
          <el-button size="small" type="primary" @click="openConfirm(row)">确认入库</el-button>
          <el-button size="small" type="danger" plain @click="doReject(row)">驳回</el-button>
        </template>
      </el-table-column>
    </el-table>

    <el-dialog v-model="confirmVisible" title="确认入库" width="420px">
      <el-form label-width="80px">
        <el-form-item label="领域">
          <el-select v-model="form.field" style="width: 100%">
            <el-option v-for="(label, v) in fieldLabels" :key="v" :label="label" :value="v" />
          </el-select>
        </el-form-item>
        <el-form-item label="密级">
          <el-select v-model="form.sensitivity" style="width: 100%">
            <el-option v-for="(label, v) in sensitivityLabels" :key="v" :label="label" :value="v" />
          </el-select>
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="confirmVisible = false">取消</el-button>
        <el-button type="primary" @click="doConfirm">确认</el-button>
      </template>
    </el-dialog>
  </div>
</template>
