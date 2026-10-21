<template>
  <div class="page-card">
    <div class="page-head">
      <h2>资料库（直接读 GBrain）</h2>
      <div>
        <el-button size="small" :loading="loading" @click="loadStatus">刷新状态</el-button>
      </div>
    </div>

    <!-- 状态卡片 -->
    <div v-if="status" class="stat-grid">
      <div class="stat-card">
        <div class="stat-num">{{ status.total }}</div>
        <div class="stat-label">页面总数</div>
      </div>
      <div class="stat-card">
        <div class="stat-num">{{ status.stats.chunkCount }}</div>
        <div class="stat-label">检索片段</div>
      </div>
      <div class="stat-card" :class="{ warn: status.stats.linkCount === 0 }">
        <div class="stat-num">{{ status.stats.linkCount }}</div>
        <div class="stat-label">页面互链</div>
      </div>
      <div class="stat-card" :class="{ off: status.stats.embeddedCount === 0 }">
        <div class="stat-num">{{ status.stats.embeddedCount === 0 ? '关' : status.stats.embeddedCount }}</div>
        <div class="stat-label">语义检索</div>
      </div>
      <div class="stat-card">
        <div class="stat-num">{{ status.malformedSlugs }}</div>
        <div class="stat-label">命名不规范</div>
      </div>
    </div>

    <div v-if="status" class="dist">
      <span class="dist-title">按领域</span>
      <el-tag v-for="(n, k) in status.byField" :key="k" size="small" style="margin-right: 6px">{{ k }} {{ n }}</el-tag>
      <span class="dist-title" style="margin-left: 16px">按密级</span>
      <el-tag v-for="(n, k) in status.bySensitivity" :key="k" size="small" type="info" style="margin-right: 6px">
        {{ k }} {{ n }}
      </el-tag>
      <span v-if="status.stats.linkCount === 0" class="hint warn-text">
        ⚠ 页面互链为 0，检索只能靠关键词；可开启 gbrain 的 wikilink 解析
      </span>
    </div>

    <!-- 筛选 -->
    <div class="filters">
      <el-input v-model="query.keyword" placeholder="搜标题或 slug" clearable style="width: 240px" @keyup.enter="reload" />
      <el-select v-model="query.field" placeholder="全部领域" clearable style="width: 130px">
        <el-option label="电气" value="electrical" />
        <el-option label="调度" value="dispatch" />
        <el-option label="机械" value="mechanical" />
      </el-select>
      <el-select v-model="query.sensitivity" placeholder="全部密级" clearable style="width: 140px">
        <el-option label="公开" value="public" />
        <el-option label="内部" value="internal" />
        <el-option label="机密" value="confidential" />
        <el-option v-if="isOwner" label="绝密" value="top_secret" />
      </el-select>
      <el-button type="primary" @click="reload">筛选</el-button>
      <span class="hint">共 {{ total }} 条</span>
    </div>

    <!-- 列表 -->
    <el-table :data="list" size="small" v-loading="loading" style="margin-top: 8px">
      <el-table-column prop="title" label="标题" min-width="240" show-overflow-tooltip>
        <template #default="{ row }">
          <el-link type="primary" @click="openPage(row.slug)">{{ row.title }}</el-link>
        </template>
      </el-table-column>
      <el-table-column prop="slug" label="slug" min-width="260" show-overflow-tooltip />
      <el-table-column prop="field" label="领域" width="90" />
      <el-table-column prop="sensitivity" label="密级" width="100">
        <template #default="{ row }">
          <el-tag size="small" :type="row.sensitivity === 'public' ? 'success' : row.sensitivity === 'internal' ? 'info' : 'warning'">
            {{ row.sensitivity }}
          </el-tag>
        </template>
      </el-table-column>
      <el-table-column prop="type" label="类型" width="100" />
      <el-table-column prop="updatedAt" label="更新时间" width="170">
        <template #default="{ row }">{{ fmt(row.updatedAt) }}</template>
      </el-table-column>
      <el-table-column label="操作" width="150" fixed="right">
        <template #default="{ row }">
          <el-button size="small" text type="primary" @click="openPage(row.slug)">查看</el-button>
          <el-button size="small" text type="danger" @click="remove(row)">删除</el-button>
        </template>
      </el-table-column>
    </el-table>

    <div class="pager">
      <el-pagination
        v-model:current-page="query.page"
        :page-size="query.size"
        :total="total"
        layout="prev, pager, next, total"
        @current-change="loadList"
      />
    </div>

    <!-- 正文弹窗 -->
    <el-dialog v-model="detailVisible" :title="currentSlug" width="70%" top="6vh">
      <div v-loading="detailLoading" class="md-body" v-html="rendered" />
      <template #footer>
        <el-button @click="detailVisible = false">关闭</el-button>
        <el-button type="danger" plain @click="remove({ slug: currentSlug, title: currentSlug })">删除这一页</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import MarkdownIt from 'markdown-it'
import { kbApi, type KbPageItem, type KbStatus } from '@/api/endpoints'
import { useAuthStore } from '@/stores/auth'

const md = new MarkdownIt({ html: false, linkify: true, breaks: false })
const auth = useAuthStore()
const isOwner = computed(() => auth.user?.role === 'owner')

const loading = ref(false)
const status = ref<KbStatus | null>(null)
const list = ref<KbPageItem[]>([])
const total = ref(0)
const query = reactive({ keyword: '', field: '', sensitivity: '', page: 1, size: 20 })

const detailVisible = ref(false)
const detailLoading = ref(false)
const currentSlug = ref('')
const currentBody = ref('')
const rendered = computed(() => md.render(currentBody.value || ''))

function fmt(v: string | null) {
  return v ? v.replace('T', ' ').slice(0, 16) : '—'
}

async function loadStatus() {
  loading.value = true
  try {
    status.value = await kbApi.status()
  } catch {
    ElMessage.error('读库状态失败')
  } finally {
    loading.value = false
  }
}

async function loadList() {
  loading.value = true
  try {
    const r = await kbApi.pages({
      keyword: query.keyword || undefined,
      field: query.field || undefined,
      sensitivity: query.sensitivity || undefined,
      page: query.page,
      size: query.size,
    })
    list.value = r.list
    total.value = r.total
  } catch {
    ElMessage.error('读页面列表失败')
  } finally {
    loading.value = false
  }
}

function reload() {
  query.page = 1
  void loadList()
}

async function openPage(slug: string) {
  currentSlug.value = slug
  currentBody.value = ''
  detailVisible.value = true
  detailLoading.value = true
  try {
    const r = await kbApi.page(slug)
    currentBody.value = r.content
  } catch (e) {
    const msg = (e as { response?: { data?: { message?: string } } })?.response?.data?.message || '读取正文失败'
    ElMessage.error(msg)
  } finally {
    detailLoading.value = false
  }
}

async function remove(row: { slug: string; title: string }) {
  try {
    await ElMessageBox.confirm(
      `确定从知识库里删除「${row.title || row.slug}」？\n会同时删除：页面、检索片段、磁盘上的 md 文件。此操作不可撤销。`,
      '删除知识页',
      { type: 'warning', confirmButtonText: '确认删除', cancelButtonText: '取消' },
    )
  } catch {
    return
  }
  try {
    const r = await kbApi.remove(row.slug)
    ElMessage.success(`已删除（顺带清了 ${r.cleanedDocs} 条登记条目）`)
    detailVisible.value = false
    await Promise.all([loadList(), loadStatus()])
  } catch (e) {
    const msg = (e as { response?: { data?: { message?: string } } })?.response?.data?.message || '删除失败'
    ElMessage.error(msg)
  }
}

onMounted(() => {
  void loadStatus()
  void loadList()
})
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
.stat-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(120px, 1fr));
  gap: 10px;
  margin-bottom: 12px;
}
.stat-card {
  border: 1px solid #ebeef5;
  border-radius: 8px;
  padding: 12px;
  text-align: center;
  background: #fafcff;
}
.stat-card.warn {
  border-color: #f5c2c7;
  background: #fff6f6;
}
.stat-card.off {
  border-color: #e6e8eb;
  background: #f7f8fa;
}
.stat-num {
  font-size: 22px;
  font-weight: 600;
  color: #2c3e50;
}
.stat-label {
  font-size: 12px;
  color: #8492a6;
  margin-top: 2px;
}
.dist {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 4px;
  margin-bottom: 12px;
  font-size: 13px;
}
.dist-title {
  color: #606266;
  margin-right: 4px;
}
.hint {
  font-size: 12px;
  color: #8492a6;
  margin-left: 8px;
}
.warn-text {
  color: #c45656;
}
.filters {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
.pager {
  margin-top: 12px;
  display: flex;
  justify-content: flex-end;
}
.md-body {
  max-height: 62vh;
  overflow: auto;
  line-height: 1.75;
  font-size: 14px;
}
</style>
