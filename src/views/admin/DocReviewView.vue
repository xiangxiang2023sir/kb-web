<script setup lang="ts">
import { onMounted, reactive, ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { useRouter } from 'vue-router'
import { adminApi } from '@/api/endpoints'
import { useAuthStore } from '@/stores/auth'
import type { DocItem, Field, Sensitivity } from '@/types'
import { fieldLabels, sensitivityLabels } from '@/utils/labels'

const auth = useAuthStore()
const router = useRouter()

function openDetail(row: DocItem) {
  router.push(`/admin/docs/${row.id}`)
}
/** 管理员不能确认绝密，只有主人可以 */
const isOwner = () => auth.user?.role === 'owner'

const list = ref<DocItem[]>([])
const users = ref<{ id: string; name: string }[]>([])
function nameOf(id?: string | null) {
  if (!id) return '—'
  return users.value.find((u) => u.id === id)?.name || String(id).slice(0, 8)
}
function viaLabel(v?: string | null) {
  const map: Record<string, string> = { upload: '上传', chat: '对话', agent: 'agent', feishu: '飞书', legacy: '历史' }
  return v ? map[v] || v : '—'
}

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
  // 用表格里改过的值（Hermes 的建议只是默认值，人改过就以人改的为准）
  form.field = row.suggestedField ?? row.field
  form.sensitivity = row.suggestedSensitivity ?? row.sensitivity
  if (form.sensitivity === 'top_secret' && !isOwner()) {
    ElMessage.warning('只有主人可以把文档定为绝密，请先切成机密或以下')
  }
  confirmVisible.value = true
}

async function doConfirm() {
  if (!current.value) return
  try {
    await adminApi.confirmDoc(current.value.id, form.field, form.sensitivity)
    ElMessage.success('已确认入库')
    confirmVisible.value = false
    void load()
  } catch (err) {
    // 把后端的原因原样显示（如「只有主人可以把文档定为绝密」），别只报"操作失败"
    const msg =
      (err as { response?: { data?: { message?: string } } })?.response?.data?.message ||
      (err as Error).message ||
      '操作失败，请重试'
    ElMessage.error(msg)
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
      <el-table-column label="标题" min-width="220" show-overflow-tooltip>
        <template #default="{ row }">
          <el-link type="primary" :underline="true" @click="openDetail(row)">{{ row.title }}</el-link>
        </template>
      </el-table-column>
      <el-table-column label="提交人" width="160">
        <template #default="{ row }">
          <span>{{ nameOf(row.submittedBy) }}</span>
          <el-tag size="small" type="info" style="margin-left: 4px">{{ viaLabel(row.submittedVia) }}</el-tag>
        </template>
      </el-table-column>
      <el-table-column label="领域（可改）" width="150">
        <template #default="{ row }">
          <el-select v-model="row.suggestedField" size="small" style="width: 100%">
            <el-option v-for="(label, v) in fieldLabels" :key="v" :label="label" :value="v" />
          </el-select>
        </template>
      </el-table-column>
      <el-table-column label="密级（可改）" width="150">
        <template #default="{ row }">
          <el-select v-model="row.suggestedSensitivity" size="small" style="width: 100%">
            <el-option
              v-for="(label, v) in sensitivityLabels"
              :key="v"
              :label="label"
              :value="v"
              :disabled="v === 'top_secret' && !isOwner()"
            />
          </el-select>
        </template>
      </el-table-column>
      <el-table-column label="操作" width="250">
        <template #default="{ row }">
          <el-button size="small" @click="openDetail(row)">查看</el-button>
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
            <el-option
              v-for="(label, v) in sensitivityLabels"
              :key="v"
              :label="label"
              :value="v"
              :disabled="v === 'top_secret' && !isOwner()"
            />
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
