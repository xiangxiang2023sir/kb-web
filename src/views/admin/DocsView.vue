<script setup lang="ts">
import { onMounted, reactive, ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { useRouter } from 'vue-router'
import { adminApi, projectsApi } from '@/api/endpoints'
import type { DocItem, DocStatus, Field, Sensitivity } from '@/types'
import { docStatusLabels, fieldLabels, formatTime, sensitivityLabels } from '@/utils/labels'

const router = useRouter()
const list = ref<DocItem[]>([])
const total = ref(0)
const loading = ref(false)
const users = ref<{ id: string; name: string }[]>([])
const projects = ref<{ id: string; name: string }[]>([])

const query = reactive<{
  keyword: string
  field?: Field
  sensitivity?: Sensitivity
  status?: DocStatus
  page: number
  size: number
}>({ keyword: '', page: 1, size: 20 })

/** 顶部状态页签（待确认已并入这里） */
const activeTab = ref<'all' | 'pending' | 'confirmed' | 'rejected'>('all')

async function load() {
  loading.value = true
  try {
    const res = await adminApi.docs({
      ...query,
      status: activeTab.value === 'all' ? query.status : (activeTab.value as DocStatus),
      keyword: query.keyword || undefined,
    })
    list.value = res.list
    total.value = res.total
  } finally {
    loading.value = false
  }
}

function switchTab(name: 'all' | 'pending' | 'confirmed' | 'rejected') {
  activeTab.value = name
  query.page = 1
  void load()
}

onMounted(async () => {
  users.value = (await adminApi.users().catch(() => [])) as { id: string; name: string }[]
  projects.value = await projectsApi.mine().catch(() => [])
  await load()
})

function reload() {
  query.page = 1
  void load()
}

function openDoc(row: DocItem) {
  router.push(`/admin/docs/${row.id}`)
}

const statusTagType = (s: DocStatus) =>
  s === 'confirmed' ? 'success' : s === 'pending' ? 'warning' : ('danger' as const)

function nameOf(id?: string | null) {
  if (!id) return '—'
  return users.value.find((u) => u.id === id)?.name || String(id).slice(0, 8)
}
function viaLabel(v?: string | null) {
  const map: Record<string, string> = { upload: '上传', chat: '对话', agent: 'agent', feishu: '飞书', question: '问题队列', legacy: '历史' }
  return v ? map[v] || v : '—'
}

// ---- 待确认：确认入库 / 驳回 ----
const confirmVisible = ref(false)
const rejectVisible = ref(false)
const acting = ref<DocItem | null>(null)
const confirmForm = reactive<{ field: Field; sensitivity: Sensitivity; project: string }>({
  field: 'electrical',
  sensitivity: 'internal',
  project: '',
})

function openConfirm(row: DocItem) {
  acting.value = row
  confirmForm.field = row.suggestedField || row.field
  confirmForm.sensitivity = row.suggestedSensitivity || row.sensitivity
  confirmForm.project = row.projectId || ''
  confirmVisible.value = true
}

async function doConfirm() {
  if (!acting.value) return
  try {
    await adminApi.confirmDoc(acting.value.id, confirmForm.field, confirmForm.sensitivity, confirmForm.project || null)
    ElMessage.success('已入库')
    confirmVisible.value = false
    await load()
  } catch (e) {
    const msg = (e as { response?: { data?: { message?: string } } })?.response?.data?.message || '入库失败'
    ElMessage.error(msg)
  }
}

function openReject(row: DocItem) {
  acting.value = row
  rejectVisible.value = true
}

async function doReject() {
  if (!acting.value) return
  try {
    const { value } = await ElMessageBox.prompt('驳回原因（提交人能看到）', '驳回', {
      inputPlaceholder: '如：重复内容 / 资料不全',
      confirmButtonText: '驳回',
      cancelButtonText: '取消',
    })
    await adminApi.rejectDoc(acting.value.id, value || '未说明')
    ElMessage.success('已驳回')
    rejectVisible.value = false
    await load()
  } catch {
    /* 取消 */
  }
}
</script>

<template>
  <div class="page-card">
    <div class="filter-bar" style="margin-bottom: 10px">
      <el-radio-group :model-value="activeTab" @change="(v: string | number | boolean | undefined) => switchTab(String(v) as 'all')">
        <el-radio-button value="all">全部</el-radio-button>
        <el-radio-button value="pending">待确认</el-radio-button>
        <el-radio-button value="confirmed">已入库</el-radio-button>
        <el-radio-button value="rejected">已驳回</el-radio-button>
      </el-radio-group>
      <span style="margin-left: 8px; color: #909399; font-size: 13px">共 {{ total }} 条</span>
    </div>

    <div class="filter-bar">
      <el-input v-model="query.keyword" placeholder="搜索标题" clearable style="width: 220px" @keyup.enter="reload" />
      <el-select v-model="query.field" placeholder="领域" clearable style="width: 130px">
        <el-option v-for="(label, v) in fieldLabels" :key="v" :label="label" :value="v" />
      </el-select>
      <el-select v-model="query.sensitivity" placeholder="密级" clearable style="width: 130px">
        <el-option v-for="(label, v) in sensitivityLabels" :key="v" :label="label" :value="v" />
      </el-select>
      <el-button type="primary" @click="reload">查询</el-button>
    </div>

    <el-skeleton v-if="loading && !list.length" :rows="5" animated />
    <el-table v-else v-loading="loading" :data="list" @row-click="openDoc">
      <el-table-column prop="title" label="标题" min-width="220" show-overflow-tooltip />
      <el-table-column label="提交人" width="160">
        <template #default="{ row }">
          <span>{{ nameOf(row.submittedBy) }}</span>
          <el-tag size="small" type="info" style="margin-left: 4px">{{ viaLabel(row.submittedVia) }}</el-tag>
        </template>
      </el-table-column>
      <el-table-column label="项目" width="130">
        <template #default="{ row }">
          <span>{{ projects.find((p) => p.id === row.projectId)?.name || '公共库' }}</span>
        </template>
      </el-table-column>
      <el-table-column label="领域" width="100">
        <template #default="{ row }">{{ fieldLabels[row.field as Field] }}</template>
      </el-table-column>
      <el-table-column label="密级" width="100">
        <template #default="{ row }">
          <el-tag size="small" effect="plain">{{ sensitivityLabels[row.sensitivity as Sensitivity] }}</el-tag>
        </template>
      </el-table-column>
      <el-table-column label="状态" width="110">
        <template #default="{ row }">
          <el-tag size="small" :type="statusTagType(row.status)">{{ docStatusLabels[row.status as DocStatus] }}</el-tag>
        </template>
      </el-table-column>
      <el-table-column label="驳回原因" min-width="160" show-overflow-tooltip>
        <template #default="{ row }">
          <span :style="row.rejectReason ? 'color: #d9453d' : 'color: #c0c4cc'">{{ row.rejectReason || '—' }}</span>
        </template>
      </el-table-column>
      <el-table-column label="更新时间" width="170">
        <template #default="{ row }">{{ formatTime(row.updatedAt) }}</template>
      </el-table-column>
      <el-table-column label="操作" width="150" fixed="right">
        <template #default="{ row }">
          <template v-if="row.status === 'pending'">
            <el-button size="small" text type="primary" @click.stop="openConfirm(row)">确认</el-button>
            <el-button size="small" text type="danger" @click.stop="openReject(row)">驳回</el-button>
          </template>
          <el-button v-else size="small" text @click.stop="openDoc(row)">查看</el-button>
        </template>
      </el-table-column>
    </el-table>

    <el-pagination
      v-model:current-page="query.page"
      :total="total"
      :page-size="query.size"
      layout="total, prev, pager, next"
      style="margin-top: 14px; justify-content: flex-end"
      @current-change="load"
    />

    <!-- 确认入库 -->
    <el-dialog v-model="confirmVisible" title="确认入库" width="460px">
      <el-form label-width="80px">
        <el-form-item label="领域">
          <el-select v-model="confirmForm.field" style="width: 100%">
            <el-option v-for="(label, v) in fieldLabels" :key="v" :label="label" :value="v" />
          </el-select>
        </el-form-item>
        <el-form-item label="密级">
          <el-select v-model="confirmForm.sensitivity" style="width: 100%">
            <el-option v-for="(label, v) in sensitivityLabels" :key="v" :label="label" :value="v" />
          </el-select>
        </el-form-item>
        <el-form-item label="归属项目">
          <el-select v-model="confirmForm.project" clearable placeholder="不选 = 公共库" style="width: 100%">
            <el-option v-for="p in projects" :key="p.id" :label="p.name" :value="p.id" />
          </el-select>
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="confirmVisible = false">取消</el-button>
        <el-button type="primary" @click="doConfirm">确认入库</el-button>
      </template>
    </el-dialog>
  </div>
</template>
