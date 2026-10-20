<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { ElMessage, ElMessageBox } from 'element-plus'
import { chatApi } from '@/api/endpoints'
import { useAuthStore } from '@/stores/auth'
import type { ChatArchive, Session } from '@/types'
import { chatSourceLabels, formatTime } from '@/utils/labels'

const router = useRouter()
const auth = useAuthStore()
const list = ref<Session[]>([])
const archives = ref<ChatArchive[]>([])
const loading = ref(false)
const archiveLoading = ref(false)
const preview = ref('')
const previewTitle = ref('')
const previewOpen = ref(false)
const previewTarget = ref<ChatArchive | null>(null)

const showAsker = computed(() => auth.isAdmin)

onMounted(() => {
  void load()
})

async function load() {
  loading.value = true
  try {
    list.value = await chatApi.sessions()
    archives.value = await chatApi.archives()
  } finally {
    loading.value = false
  }
}

function open(row: Session) {
  router.push(`/chat/${row.id}`)
}

function sourceLabel(source: unknown) {
  if (source === 'web' || source === 'agent') return chatSourceLabels[source]
  return '网页'
}

async function remove(row: Session, e: Event) {
  e.stopPropagation()
  try {
    await ElMessageBox.confirm(`删除「${row.title}」后无法恢复。`, '删除会话', { type: 'warning' })
  } catch {
    return
  }
  try {
    await chatApi.deleteSession(row.id)
    list.value = list.value.filter((s) => s.id !== row.id)
    ElMessage.success('已删除')
  } catch {
    ElMessage.error('删除失败')
  }
}

async function openArchive(row: ChatArchive) {
  try {
    const r = await chatApi.archive(row.userId, row.weekKey)
    previewTitle.value = r.title
    preview.value = r.markdown
    previewTarget.value = row
    previewOpen.value = true
  } catch {
    ElMessage.error('打开归档失败')
  }
}

async function sendArchive(row: ChatArchive) {
  try {
    const r = await chatApi.archiveToPending(row.userId, row.weekKey)
    ElMessage.success(r.duplicate ? '这篇已经在待确认队列里了' : '已送入待确认')
    previewOpen.value = false
  } catch {
    ElMessage.error('提交失败')
  }
}

async function runArchive() {
  archiveLoading.value = true
  try {
    const r = await chatApi.runArchives()
    ElMessage.success(`已生成 ${r.weekKey}，共 ${r.files} 份`)
    archives.value = await chatApi.archives()
  } catch {
    ElMessage.error('生成失败')
  } finally {
    archiveLoading.value = false
  }
}
</script>

<template>
  <div class="app-content">
    <div class="page-card">
      <div class="card-head">
        <h3>历史会话</h3>
        <p v-if="showAsker" class="hint">主人和管理员能看到所有人的记录；点开别人的会话是只读的。</p>
      </div>
      <el-skeleton v-if="loading && !list.length" :rows="5" animated />
      <el-table v-else v-loading="loading" :data="list" empty-text="暂无历史会话" @row-click="open">
        <el-table-column prop="title" label="标题" min-width="200" />
        <el-table-column v-if="showAsker" label="提问人" width="110">
          <template #default="{ row }">{{ row.userName || '—' }}</template>
        </el-table-column>
        <el-table-column label="来源" width="90">
          <template #default="{ row }">
            {{ sourceLabel(row.source) }}
          </template>
        </el-table-column>
        <el-table-column prop="preview" label="最近内容" min-width="240" show-overflow-tooltip />
        <el-table-column label="更新时间" width="180">
          <template #default="{ row }">{{ formatTime(row.updatedAt) }}</template>
        </el-table-column>
        <el-table-column label="" width="90" align="right">
          <template #default="{ row }">
            <el-button size="small" type="danger" link @click="remove(row, $event)">删除</el-button>
          </template>
        </el-table-column>
      </el-table>
    </div>

    <div class="page-card" style="margin-top: 16px">
      <div class="card-head">
        <h3>周归档</h3>
        <el-button v-if="showAsker" size="small" :loading="archiveLoading" @click="runArchive">
          生成上周归档
        </el-button>
      </div>
      <p class="hint">落在本机文件，不自动进正式库。有用的可以送入待确认。</p>
      <el-table :data="archives" empty-text="还没有周归档">
        <el-table-column prop="weekKey" label="周次" width="120" />
        <el-table-column v-if="showAsker" prop="userName" label="账号" width="120" />
        <el-table-column prop="title" label="标题" min-width="220" />
        <el-table-column label="生成时间" width="180">
          <template #default="{ row }">{{ formatTime(row.createdAt) }}</template>
        </el-table-column>
        <el-table-column label="" width="180" align="right">
          <template #default="{ row }">
            <el-button size="small" link @click="openArchive(row)">查看</el-button>
            <el-button size="small" type="success" link @click="sendArchive(row)">送入待确认</el-button>
          </template>
        </el-table-column>
      </el-table>
    </div>

    <el-dialog v-model="previewOpen" :title="previewTitle" width="640px">
      <pre class="archive-body">{{ preview }}</pre>
      <template #footer>
        <el-button @click="previewOpen = false">关闭</el-button>
        <el-button v-if="previewTarget" type="primary" @click="sendArchive(previewTarget)">送入待确认</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<style scoped>
.card-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 8px;
}

.card-head h3 {
  margin: 0;
  font-size: 16px;
}

.hint {
  margin: 0 0 12px;
  color: var(--kb-text-secondary);
  font-size: 13px;
}

.archive-body {
  max-height: 60vh;
  overflow: auto;
  white-space: pre-wrap;
  font-family: inherit;
  font-size: 13px;
  line-height: 1.6;
  margin: 0;
}
</style>
