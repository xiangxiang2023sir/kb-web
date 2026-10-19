<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { adminApi } from '@/api/endpoints'
import { useAuthStore } from '@/stores/auth'
import type { Field, Role, User } from '@/types'
import { fieldLabels, roleLabels } from '@/utils/labels'

const auth = useAuthStore()
const isOwner = computed(() => auth.user?.role === 'owner')

const list = ref<User[]>([])
interface PendingUser {
  id: string
  name: string
  title: string | null
  department: string | null
  appliedAt: string | null
  note: string | null
}
const pending = ref<PendingUser[]>([])
const approveForm = reactive<Record<string, { role: Role; field: Field }>>({})

async function loadPending() {
  const rows = await adminApi.pendingUsers().catch(() => [])
  pending.value = rows
  for (const r of rows) {
    if (!approveForm[r.id]) approveForm[r.id] = { role: 'operator', field: 'electrical' }
  }
}

async function approve(row: PendingUser) {
  const f = approveForm[row.id] ?? { role: 'operator' as Role, field: 'electrical' as Field }
  try {
    await adminApi.approveUser(row.id, f.role, f.role === 'operator' ? f.field : null)
    ElMessage.success(`已批准 ${row.name}`)
    await Promise.all([loadPending(), load()])
  } catch {
    ElMessage.error('批准失败')
  }
}

async function doDelete(u: User) {
  if (u.id === auth.user?.id) {
    ElMessage.warning('不能删除自己')
    return
  }
  if ((u.role === 'owner' || u.role === 'admin') && !isOwner.value) {
    ElMessage.warning('只有主人能删除管理员或主人账号')
    return
  }
  try {
    await ElMessageBox.confirm(`确定删除用户「${u.name}」？该用户的会话和外部绑定会一并清除。`, '删除用户', {
      type: 'warning',
      confirmButtonText: '删除',
      cancelButtonText: '取消',
    })
  } catch {
    return
  }
  try {
    await adminApi.deleteUser(u.id)
    ElMessage.success('已删除')
    void load()
  } catch (err) {
    const msg =
      (err as { response?: { data?: { message?: string } } })?.response?.data?.message || '删除失败'
    ElMessage.error(msg)
  }
}

async function reject(row: PendingUser) {
  try {
    await adminApi.rejectUser(row.id)
    ElMessage.success('已驳回')
    void loadPending()
  } catch {
    ElMessage.error('驳回失败')
  }
}
const loading = ref(false)

async function load() {
  loading.value = true
  try {
    list.value = await adminApi.users()
    void loadPending()
  } finally {
    loading.value = false
  }
}

onMounted(load)

const dialogVisible = ref(false)
const editing = ref<User | null>(null)
const saving = ref(false)

const form = reactive<{ name: string; password: string; role: Role; field: Field | null }>({
  name: '',
  password: '',
  role: 'operator',
  field: 'electrical',
})

function openCreate() {
  editing.value = null
  Object.assign(form, { name: '', password: '', role: 'operator', field: 'electrical' })
  dialogVisible.value = true
}

function openEdit(u: User) {
  editing.value = u
  Object.assign(form, { name: u.name, password: '', role: u.role, field: u.field })
  dialogVisible.value = true
}

async function save() {
  saving.value = true
  try {
    // 只有操作员需要领域；管理员/主人可见全部领域
    const field = form.role === 'operator' ? form.field : null
    if (editing.value) {
      await adminApi.updateUser(editing.value.id, { role: form.role, field })
    } else {
      await adminApi.createUser({ name: form.name, password: form.password, role: form.role, field })
    }
    ElMessage.success('已保存')
    dialogVisible.value = false
    void load()
  } catch {
    ElMessage.error('保存失败，请重试')
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <div class="page-card">
    <div v-if="pending.length" style="margin-bottom: 18px">
      <div style="font-size: 14px; font-weight: 600; margin-bottom: 8px">注册申请（待批准 {{ pending.length }}）</div>
      <el-table :data="pending" size="small">
        <el-table-column prop="name" label="名字" width="120" />
        <el-table-column prop="title" label="岗位" width="150" />
        <el-table-column prop="department" label="部门" width="120" />
        <el-table-column prop="note" label="说明" show-overflow-tooltip />
        <el-table-column label="批准为" width="230">
          <template #default="{ row }">
            <el-select v-model="approveForm[row.id].role" size="small" style="width: 92px">
              <el-option
                v-for="(label, v) in roleLabels"
                :key="v"
                :label="label"
                :value="v"
                :disabled="(v === 'owner' || v === 'admin') && !isOwner"
              />
            </el-select>
            <el-select
              v-if="approveForm[row.id].role === 'operator'"
              v-model="approveForm[row.id].field"
              size="small"
              style="width: 100px; margin-left: 6px"
            >
              <el-option v-for="(label, v) in fieldLabels" :key="v" :label="label" :value="v" />
            </el-select>
          </template>
        </el-table-column>
        <el-table-column label="操作" width="150">
          <template #default="{ row }">
            <el-button size="small" type="primary" @click="approve(row)">批准</el-button>
            <el-button size="small" text type="danger" @click="reject(row)">驳回</el-button>
          </template>
        </el-table-column>
      </el-table>
    </div>
    <div class="filter-bar">
      <el-button v-if="isOwner" type="primary" @click="openCreate">新增用户</el-button>
      <span v-else style="font-size: 13px; color: #8492a6">管理员可以审批注册申请；新增/改角色只有主人能做</span>
    </div>

    <el-skeleton v-if="loading && !list.length" :rows="5" animated />
    <el-table v-else v-loading="loading" :data="list">
      <el-table-column prop="name" label="用户名" min-width="160" />
      <el-table-column label="角色" width="120">
        <template #default="{ row }">{{ roleLabels[row.role as Role] }}</template>
      </el-table-column>
      <el-table-column label="领域" width="120">
        <template #default="{ row }">{{ row.field ? fieldLabels[row.field as Field] : '全部' }}</template>
      </el-table-column>
      <el-table-column label="操作" width="190">
        <template #default="{ row }">
          <el-button v-if="isOwner" size="small" @click="openEdit(row)">编辑</el-button>
          <el-button size="small" text type="danger" @click="doDelete(row)">删除</el-button>
        </template>
      </el-table-column>
    </el-table>

    <el-dialog v-model="dialogVisible" :title="editing ? '编辑用户' : '新增用户'" width="420px">
      <el-form label-width="80px">
        <el-form-item label="用户名">
          <el-input v-model="form.name" :disabled="!!editing" />
        </el-form-item>
        <el-form-item v-if="!editing" label="初始密码">
          <el-input v-model="form.password" type="password" show-password />
        </el-form-item>
        <el-form-item label="角色">
          <el-select v-model="form.role" style="width: 100%">
            <el-option v-for="(label, v) in roleLabels" :key="v" :label="label" :value="v" />
          </el-select>
        </el-form-item>
        <el-form-item v-if="form.role === 'operator'" label="领域">
          <el-select v-model="form.field" style="width: 100%">
            <el-option v-for="(label, v) in fieldLabels" :key="v" :label="label" :value="v" />
          </el-select>
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="dialogVisible = false">取消</el-button>
        <el-button type="primary" :loading="saving" @click="save">保存</el-button>
      </template>
    </el-dialog>
  </div>
</template>
