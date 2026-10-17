<script setup lang="ts">
import { onMounted, reactive, ref } from 'vue'
import { ElMessage } from 'element-plus'
import { adminApi } from '@/api/endpoints'
import type { Field, Role, User } from '@/types'
import { fieldLabels, roleLabels } from '@/utils/labels'

const list = ref<User[]>([])
const loading = ref(false)

async function load() {
  loading.value = true
  try {
    list.value = await adminApi.users()
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
    <div class="filter-bar">
      <el-button type="primary" @click="openCreate">新增用户</el-button>
    </div>

    <el-table v-loading="loading" :data="list">
      <el-table-column prop="name" label="用户名" min-width="160" />
      <el-table-column label="角色" width="120">
        <template #default="{ row }">{{ roleLabels[row.role as Role] }}</template>
      </el-table-column>
      <el-table-column label="领域" width="120">
        <template #default="{ row }">{{ row.field ? fieldLabels[row.field as Field] : '全部' }}</template>
      </el-table-column>
      <el-table-column label="操作" width="120">
        <template #default="{ row }">
          <el-button size="small" @click="openEdit(row)">编辑</el-button>
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
