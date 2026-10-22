<template>
  <div class="page-card">
    <div class="page-head">
      <h2>项目管理</h2>
      <div>
        <el-button size="small" @click="load">刷新</el-button>
        <el-button size="small" type="primary" @click="openCreate">新建项目</el-button>
      </div>
    </div>

    <el-table :data="list" size="small" v-loading="loading">
      <el-table-column prop="name" label="项目" min-width="180">
        <template #default="{ row }">
          <span style="font-weight: 600">{{ row.name }}</span>
          <span class="slug">{{ row.id }}</span>
        </template>
      </el-table-column>
      <el-table-column label="知识库分区" min-width="160">
        <template #default="{ row }">
          <span>{{ partitionLabel(row) }}</span>
          <el-tag v-if="isOwnPartition(row) && row.sourceReady === false" size="small" type="danger" style="margin-left: 6px">未建分区</el-tag>
        </template>
      </el-table-column>
      <el-table-column prop="note" label="说明" min-width="180" show-overflow-tooltip />
      <el-table-column label="负责人" min-width="140">
        <template #default="{ row }">
          <el-tag v-for="n in row.leads || []" :key="n" size="small" type="warning" style="margin-right: 4px">{{ n }}</el-tag>
          <span v-if="!(row.leads || []).length" class="slug">未设置</span>
        </template>
      </el-table-column>
      <el-table-column label="成员数" width="90">
        <template #default="{ row }">{{ row.memberCount ?? 0 }}</template>
      </el-table-column>
      <el-table-column label="状态" width="100">
        <template #default="{ row }">
          <el-tag size="small" :type="row.status === 'active' ? 'success' : 'info'">
            {{ row.status === 'active' ? '进行中' : '已归档' }}
          </el-tag>
        </template>
      </el-table-column>
      <el-table-column label="操作" width="280" fixed="right">
        <template #default="{ row }">
          <el-button size="small" text type="primary" @click="openMembers(row)">成员</el-button>
          <el-button
            v-if="isOwnPartition(row) && row.sourceReady === false"
            size="small"
            text
            type="warning"
            :loading="ensuring === row.id"
            @click="doEnsure(row)"
          >
            补建分区
          </el-button>
          <el-button size="small" text @click="toggleStatus(row)">
            {{ row.status === 'active' ? '归档' : '恢复' }}
          </el-button>
        </template>
      </el-table-column>
    </el-table>

    <!-- 新建 -->
    <el-dialog v-model="createVisible" title="新建项目" width="520px">
      <el-form label-width="90px">
        <el-form-item label="项目 id">
          <el-input v-model="form.id" placeholder="小写字母/数字/连字符，如 p-amr02" />
        </el-form-item>
        <el-form-item label="项目名称">
          <el-input v-model="form.name" placeholder="如 自研 AGV 二号车" />
        </el-form-item>
        <el-form-item label="说明">
          <el-input v-model="form.note" type="textarea" :rows="2" />
        </el-form-item>
        <el-form-item label="独立分区">
          <el-switch v-model="form.ownSource" />
          <div class="hint">勾选后会在 GBrain 建同名 source。临时项目可以关掉，入库进 tools 或公共库。</div>
        </el-form-item>
        <el-form-item v-if="!form.ownSource" label="归到">
          <el-radio-group v-model="form.attach">
            <el-radio value="tools">tools（共用工具/临时）</el-radio>
            <el-radio value="default">公共库（按领域）</el-radio>
          </el-radio-group>
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="createVisible = false">取消</el-button>
        <el-button type="primary" :loading="saving" @click="doCreate">创建</el-button>
      </template>
    </el-dialog>

    <!-- 成员 -->
    <el-dialog v-model="membersVisible" :title="`成员 · ${current?.name || ''}`" width="560px">
      <div style="display: flex; gap: 8px; margin-bottom: 10px">
        <el-select v-model="newMember.userId" placeholder="选择用户" filterable style="flex: 1">
          <el-option v-for="u in users" :key="u.id" :label="`${u.name}（${u.role}）`" :value="u.id" />
        </el-select>
        <el-select v-model="newMember.role" style="width: 120px">
          <el-option label="负责人" value="lead" />
          <el-option label="成员" value="member" />
        </el-select>
        <el-button type="primary" @click="addMember">加入</el-button>
      </div>
      <el-table :data="members" size="small">
        <el-table-column prop="name" label="成员" />
        <el-table-column label="角色" width="110">
          <template #default="{ row }">
            <el-tag size="small" :type="row.role === 'lead' ? 'warning' : 'info'">
              {{ row.role === 'lead' ? '负责人' : '成员' }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="操作" width="90">
          <template #default="{ row }">
            <el-button size="small" text type="danger" @click="removeMember(row)">移出</el-button>
          </template>
        </el-table-column>
      </el-table>
    </el-dialog>
  </div>
</template>

<script setup lang="ts">
import { onMounted, reactive, ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { adminApi, projectsApi, type ProjectItem, type ProjectMember } from '@/api/endpoints'

const loading = ref(false)
const saving = ref(false)
const list = ref<ProjectItem[]>([])
const users = ref<{ id: string; name: string; role: string }[]>([])

const createVisible = ref(false)
const ensuring = ref('')
const form = reactive({ id: '', name: '', note: '', ownSource: true, attach: 'tools' as 'tools' | 'default' })

function isOwnPartition(row: ProjectItem) {
  return (row.kbSource || row.id) === row.id
}

function partitionLabel(row: ProjectItem) {
  const src = row.kbSource || row.id
  if (src === row.id) return '独立'
  if (src === 'tools') return 'tools'
  if (src === 'default') return '公共库'
  return src
}

const membersVisible = ref(false)
const current = ref<ProjectItem | null>(null)
const members = ref<ProjectMember[]>([])
const newMember = reactive<{ userId: string; role: 'lead' | 'member' }>({ userId: '', role: 'member' })

async function load() {
  loading.value = true
  try {
    list.value = await projectsApi.list()
    users.value = (await adminApi.users().catch(() => [])) as { id: string; name: string; role: string }[]
  } finally {
    loading.value = false
  }
}

function openCreate() {
  form.id = ''
  form.name = ''
  form.note = ''
  form.ownSource = true
  form.attach = 'tools'
  createVisible.value = true
}

async function doCreate() {
  if (!form.id.trim() || !form.name.trim()) {
    ElMessage.warning('项目 id 和名称必填')
    return
  }
  saving.value = true
  try {
    const r = await projectsApi.create({
      id: form.id.trim(),
      name: form.name.trim(),
      note: form.note.trim(),
      ownSource: form.ownSource,
      attach: form.attach,
    })
    if (r.warning) ElMessage.warning(r.warning)
    else ElMessage.success(form.ownSource ? '已创建，并建好知识库分区' : '已创建（不建独立分区）')
    createVisible.value = false
    await load()
  } catch (e) {
    const msg = (e as { response?: { data?: { message?: string } } })?.response?.data?.message || '创建失败'
    ElMessage.error(msg)
  } finally {
    saving.value = false
  }
}

async function doEnsure(row: ProjectItem) {
  ensuring.value = row.id
  try {
    await projectsApi.ensureSource(row.id)
    ElMessage.success('分区已建好')
    await load()
  } catch (e) {
    const msg = (e as { response?: { data?: { message?: string } } })?.response?.data?.message || '补建失败'
    ElMessage.error(msg)
  } finally {
    ensuring.value = ''
  }
}

async function toggleStatus(row: ProjectItem) {
  const next = row.status === 'active' ? 'archived' : 'active'
  try {
    await ElMessageBox.confirm(
      next === 'archived' ? `归档「${row.name}」后，按项目检索会被拒绝（知识保留）。` : `恢复「${row.name}」？`,
      next === 'archived' ? '归档项目' : '恢复项目',
      { type: 'warning' },
    )
  } catch {
    return
  }
  await projectsApi.update(row.id, { status: next })
  ElMessage.success(next === 'archived' ? '已归档' : '已恢复')
  await load()
}

async function openMembers(row: ProjectItem) {
  current.value = row
  members.value = await projectsApi.members(row.id).catch(() => [])
  newMember.userId = ''
  newMember.role = 'member'
  membersVisible.value = true
}

async function addMember() {
  if (!current.value || !newMember.userId) return
  try {
    await projectsApi.addMember(current.value.id, newMember.userId, newMember.role)
    members.value = await projectsApi.members(current.value.id)
    await load()
    ElMessage.success('已加入')
  } catch (e) {
    const msg = (e as { response?: { data?: { message?: string } } })?.response?.data?.message || '加入失败'
    ElMessage.error(msg)
  }
}

async function removeMember(row: ProjectMember) {
  if (!current.value) return
  await projectsApi.removeMember(current.value.id, row.userId)
  members.value = await projectsApi.members(current.value.id)
  await load()
  ElMessage.success('已移出')
}

onMounted(load)
</script>

<style scoped>
.page-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 12px;
}
.page-head h2 {
  font-size: 16px;
  margin: 0;
}
.slug {
  font-size: 12px;
  color: #909399;
  margin-left: 8px;
}
.hint {
  font-size: 12px;
  color: #909399;
  line-height: 1.5;
  margin-top: 4px;
}
</style>
