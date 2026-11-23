<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { ElMessage } from 'element-plus'
import * as echarts from 'echarts/core'
import { GraphChart } from 'echarts/charts'
import { TooltipComponent } from 'echarts/components'
import { CanvasRenderer } from 'echarts/renderers'
import { kbApi, projectsApi, type KbGraph, type KbGraphNode, type KbGraphScan, type ProjectItem } from '@/api/endpoints'
import { fieldLabels, sensitivityLabels } from '@/utils/labels'
import type { Field, Sensitivity } from '@/types'

echarts.use([GraphChart, TooltipComponent, CanvasRenderer])

const FIELD_COLOR: Record<string, string> = {
  electrical: '#004898',
  dispatch: '#0d7a5f',
  mechanical: '#b45309',
}

const loading = ref(true)
const scanning = ref(false)
const graph = ref<KbGraph | null>(null)
const keyword = ref('')
/** 空 = 全部分区；值是 GBrain sourceId */
const sourceId = ref('')
const projects = ref<ProjectItem[]>([])
const selected = ref<KbGraphNode | null>(null)
const showOrphans = ref(false)
const chartEl = ref<HTMLDivElement | null>(null)
let chart: echarts.ECharts | null = null
let pollTimer: ReturnType<typeof setInterval> | null = null

const sourceOptions = computed(() => {
  const seen = new Set<string>()
  const opts: { value: string; label: string }[] = [
    { value: 'default', label: '公共库 (default)' },
    { value: 'tools', label: '工具库 (tools)' },
  ]
  for (const o of opts) seen.add(o.value)
  for (const p of projects.value) {
    const sid = (p.kbSource || p.id || '').trim()
    if (!sid || seen.has(sid)) continue
    seen.add(sid)
    opts.push({ value: sid, label: `${p.name} (${sid})` })
  }
  return opts
})

const fieldLegend = computed(() => {
  const fields = graph.value?.stats.fields ?? []
  return fields.map((f) => ({
    field: f,
    label: fieldLabels[f as Field] ?? f,
    color: colorOf(f),
  }))
})

const orphans = computed(() => (graph.value?.nodes ?? []).filter((n) => n.orphan))

const neighbors = computed(() => {
  if (!selected.value || !graph.value) return []
  const id = selected.value.id
  const ids = new Set<string>()
  for (const l of graph.value.links) {
    if (l.source === id) ids.add(l.target)
    if (l.target === id) ids.add(l.source)
  }
  return graph.value.nodes.filter((n) => ids.has(n.id))
})

const statsLine = computed(() => {
  if (!graph.value) return ''
  const s = graph.value.stats
  return `${s.nodeCount} 页 · ${s.linkCount} 条互链 · ${s.orphanCount} 孤立`
})

function colorOf(field: string) {
  return FIELD_COLOR[field] ?? '#64748b'
}

function shortLabel(title: string, slug: string) {
  const t = (title || slug).trim()
  return t.length > 10 ? `${t.slice(0, 10)}…` : t
}

function sourceLabel(id: string) {
  if (!id) return '—'
  return sourceOptions.value.find((o) => o.value === id)?.label ?? id
}

function fieldLabelOf(field: string) {
  return fieldLabels[field as Field] ?? field
}

function sensitivityLabelOf(s: string) {
  return sensitivityLabels[s as Sensitivity] ?? s
}

function statusLabel(n: KbGraphNode) {
  if (n.orphan) return '孤立页'
  if ((graph.value?.stats.linkCount ?? 0) === 0) return '未建互链'
  return '已互链'
}

const noLinks = computed(() => (graph.value?.stats.linkCount ?? 0) === 0)
const scan = computed(() => graph.value?.scan ?? null)
const scanRunning = computed(() => scan.value?.status === 'running' || scanning.value)
const needsScan = computed(() => Boolean(sourceId.value) && (scan.value?.needsScan ?? false))
const scanProgress = computed(() => {
  const s = scan.value
  if (!s || !s.pageTotal) return 0
  return Math.min(100, Math.round((s.pageDone / s.pageTotal) * 100))
})

function formatScannedAt(iso: string | null | undefined) {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  return d.toLocaleString('zh-CN', { hour12: false })
}

function stopPoll() {
  if (pollTimer) {
    clearInterval(pollTimer)
    pollTimer = null
  }
}

function applyScan(meta: KbGraphScan) {
  if (!graph.value) return
  graph.value = { ...graph.value, scan: meta }
}

async function loadProjects() {
  projects.value = await projectsApi.list().catch(() => [])
}

async function load() {
  loading.value = true
  selected.value = null
  showOrphans.value = false
  stopPoll()
  try {
    graph.value = await kbApi.graph(sourceId.value || undefined)
    if (graph.value.scan?.status === 'running' && sourceId.value) {
      scanning.value = true
      startPoll()
    } else {
      scanning.value = false
    }
    await nextTick()
    render()
  } catch {
    ElMessage.error('知识图谱加载失败')
    graph.value = null
  } finally {
    loading.value = false
  }
}

async function startScan() {
  if (!sourceId.value) {
    ElMessage.warning('请先选择分区再扫描互链')
    return
  }
  if (scanRunning.value) return
  scanning.value = true
  try {
    const meta = await kbApi.graphScan(sourceId.value)
    applyScan(meta)
    startPoll()
  } catch (err: unknown) {
    scanning.value = false
    const msg = (err as { response?: { data?: { message?: string } } })?.response?.data?.message
    ElMessage.error(msg || '启动扫描失败')
  }
}

function startPoll() {
  stopPoll()
  pollTimer = setInterval(() => {
    void pollScan()
  }, 1500)
}

async function pollScan() {
  if (!sourceId.value) {
    stopPoll()
    scanning.value = false
    return
  }
  try {
    const meta = await kbApi.graphScanStatus(sourceId.value)
    applyScan(meta)
    if (meta.status === 'done') {
      stopPoll()
      scanning.value = false
      ElMessage.success(`扫描完成：${meta.edgeCount} 条互链`)
      await load()
    } else if (meta.status === 'error') {
      stopPoll()
      scanning.value = false
      ElMessage.error(meta.error || '扫描失败')
    }
  } catch {
    /* 轮询失败下一轮再试 */
  }
}

function matches(node: KbGraphNode, q: string) {
  if (!q) return true
  const hay = `${node.title} ${node.slug} ${node.field} ${node.sourceId}`.toLowerCase()
  return hay.includes(q)
}

function selectNode(node: KbGraphNode | null) {
  selected.value = node
  if (node) showOrphans.value = false
  render()
}

function toggleOrphans() {
  showOrphans.value = !showOrphans.value
  if (showOrphans.value) selected.value = null
  render()
}

function render() {
  if (!graph.value?.nodes.length) {
    chart?.dispose()
    chart = null
    return
  }
  if (!chartEl.value) return
  if (!chart) {
    chart = echarts.init(chartEl.value)
    chart.on('click', (params) => {
      if (params.dataType !== 'node') return
      const data = params.data as { id?: string }
      const node = graph.value?.nodes.find((n) => n.id === data.id)
      selectNode(node ?? null)
    })
  }
  const q = keyword.value.trim().toLowerCase()
  const selectedId = selected.value?.id
  const categories = graph.value.stats.fields.map((f) => ({
    name: f,
    itemStyle: { color: colorOf(f) },
  }))
  const catIndex = new Map(categories.map((c, i) => [c.name, i]))
  const nodes = graph.value.nodes.map((n) => {
    const hit = matches(n, q)
    const dim = Boolean(q) && !hit
    const isSelected = selectedId === n.id
    return {
      id: n.id,
      name: shortLabel(n.title, n.slug),
      value: n.degree,
      symbolSize: Math.min(46, (isSelected ? 18 : 14) + n.degree * 5),
      category: catIndex.get(n.field) ?? 0,
      itemStyle: {
        color: colorOf(n.field),
        opacity: dim ? 0.15 : 1,
        borderColor: isSelected ? '#0f172a' : n.orphan ? '#dc2626' : undefined,
        borderWidth: isSelected ? 3 : n.orphan ? 2 : 0,
      },
      label: {
        show: !dim && (isSelected || n.degree >= 2 || Boolean(q && hit)),
        color: '#334155',
        fontSize: 11,
        fontWeight: isSelected ? 600 : 400,
      },
      tooltip: {
        formatter: () =>
          `${n.title}<br/><span style="opacity:.7">${n.slug}</span><br/>分区 ${n.sourceId || '—'} · ${fieldLabelOf(n.field)} · 度 ${n.degree}${n.orphan ? ' · 孤立' : ''}`,
      },
    }
  })
  const links = graph.value.links.map((l) => {
    const related = selectedId && (l.source === selectedId || l.target === selectedId)
    return {
      source: l.source,
      target: l.target,
      lineStyle: {
        color: related ? '#0f172a' : '#94a3b8',
        width: related ? 2 : 1,
        opacity: q ? 0.18 : related ? 0.9 : 0.5,
        curveness: 0.12,
      },
    }
  })
  chart.setOption(
    {
      backgroundColor: 'transparent',
      tooltip: { trigger: 'item' },
      series: [
        {
          type: 'graph',
          layout: 'force',
          roam: true,
          draggable: true,
          categories,
          data: nodes,
          links,
          label: { position: 'right' },
          force: { repulsion: 180, edgeLength: [48, 120], gravity: 0.08 },
          emphasis: { focus: 'adjacency', lineStyle: { width: 2 } },
        },
      ],
    },
    true,
  )
}

function onResize() {
  chart?.resize()
}

watch(keyword, () => render())
watch(sourceId, () => {
  void load()
})

onMounted(() => {
  void loadProjects().then(() => load())
  window.addEventListener('resize', onResize)
})

onBeforeUnmount(() => {
  stopPoll()
  window.removeEventListener('resize', onResize)
  chart?.dispose()
  chart = null
})
</script>

<template>
  <el-card shadow="never" class="kg-card">
    <div class="kg-head">
      <div>
        <div class="kg-title">知识图谱</div>
        <div class="kg-sub">
          <template v-if="graph">
            {{ graph.stats.nodeCount }} 页 · {{ graph.stats.linkCount }} 条互链 ·
            <button type="button" class="orphan-link" :class="{ on: showOrphans }" @click="toggleOrphans">
              {{ graph.stats.orphanCount }} 孤立
            </button>
          </template>
          <template v-else>{{ statsLine || '加载中…' }}</template>
        </div>
      </div>
      <div class="kg-actions">
        <el-select
          v-model="sourceId"
          clearable
          size="small"
          placeholder="全部分区"
          style="width: 200px"
        >
          <el-option v-for="o in sourceOptions" :key="o.value" :label="o.label" :value="o.value" />
        </el-select>
        <el-input
          v-model="keyword"
          clearable
          size="small"
          placeholder="搜索页名 / slug"
          style="width: 160px"
        />
        <el-button
          v-if="sourceId"
          size="small"
          type="primary"
          plain
          :loading="scanRunning"
          @click="startScan"
        >
          {{ scan?.status === 'done' ? '刷新互链' : '扫描互链' }}
        </el-button>
        <el-button size="small" :loading="loading" @click="load">刷新</el-button>
      </div>
    </div>

    <div v-if="fieldLegend.length" class="kg-legend">
      <span v-for="item in fieldLegend" :key="item.field" class="legend-item">
        <i class="dot" :style="{ background: item.color }" />
        {{ item.label }}
      </span>
      <span v-if="!noLinks || orphans.length" class="legend-item">
        <i class="dot orphan" />
        孤立（红框）
      </span>
    </div>

    <div v-if="graph && !sourceId" class="kg-banner">
      全库模式只浏览节点与孤立清单。互链按分区缓存，请选择分区后扫描（约 1 分钟），之后打开秒出。
    </div>
    <div v-else-if="graph && needsScan" class="kg-banner kg-banner-action">
      <span>分区「{{ sourceLabel(sourceId) }}」尚未扫描互链快照。</span>
      <el-button size="small" type="primary" :loading="scanRunning" @click="startScan">扫描互链（约 1 分钟）</el-button>
    </div>
    <div v-else-if="graph && scanRunning" class="kg-banner">
      正在扫描互链：{{ scan?.pageDone ?? 0 }}/{{ scan?.pageTotal ?? 0 }}
      <div class="kg-progress"><i :style="{ width: `${scanProgress}%` }" /></div>
    </div>
    <div v-else-if="graph && sourceId && scan?.status === 'done'" class="kg-banner kg-banner-ok">
      互链快照 {{ graph.stats.linkCount }} 条
      <template v-if="scan.scannedAt"> · 扫描于 {{ formatScannedAt(scan.scannedAt) }}</template>
      <span class="kg-muted">（非实时，改文后请点「刷新互链」）</span>
    </div>
    <div v-else-if="graph && scan?.status === 'error'" class="kg-banner kg-banner-err">
      上次扫描失败：{{ scan.error || '未知错误' }}
      <el-button size="small" @click="startScan">重试</el-button>
    </div>

    <el-skeleton v-if="loading && !graph" :rows="6" animated />
    <div v-else-if="graph && graph.nodes.length" class="kg-body">
      <div ref="chartEl" class="kg-chart" />

      <aside v-if="selected" class="kg-panel">
        <div class="panel-top">
          <div class="preview-title">{{ selected.title }}</div>
          <button type="button" class="panel-close" aria-label="关闭" @click="selectNode(null)">×</button>
        </div>
        <div class="preview-slug">{{ selected.slug }}</div>
        <dl>
          <div><dt>分区</dt><dd>{{ sourceLabel(selected.sourceId) }}</dd></div>
          <div><dt>领域</dt><dd>{{ fieldLabelOf(selected.field) }}</dd></div>
          <div><dt>密级</dt><dd>{{ sensitivityLabelOf(selected.sensitivity) }}</dd></div>
          <div><dt>互链度</dt><dd>{{ selected.degree }}</dd></div>
          <div><dt>状态</dt><dd>{{ statusLabel(selected) }}</dd></div>
        </dl>
        <div v-if="neighbors.length" class="neighbor-block">
          <div class="neighbor-title">相邻页</div>
          <button
            v-for="n in neighbors"
            :key="n.id"
            type="button"
            class="neighbor-item"
            @click="selectNode(n)"
          >
            {{ n.title }}
          </button>
        </div>
        <el-button
          text
          type="primary"
          size="small"
          @click="$router.push({ path: '/admin/kb', query: { q: selected.slug, project: selected.sourceId } })"
        >
          在资料库中查看
        </el-button>
      </aside>

      <aside v-else-if="showOrphans" class="kg-panel">
        <div class="panel-top">
          <div class="preview-title">孤立页（{{ orphans.length }}）</div>
          <button type="button" class="panel-close" aria-label="关闭" @click="showOrphans = false">×</button>
        </div>
        <p class="panel-tip">
          {{ noLinks ? '来自 gbrain orphans（库尚无互链时的治理清单）' : '没有 LINKS 互链的页面，可点选查看' }}
        </p>
        <button
          v-for="n in orphans"
          :key="n.id"
          type="button"
          class="neighbor-item"
          @click="selectNode(n)"
        >
          {{ n.title }}
          <span class="muted">{{ n.sourceId }}</span>
        </button>
        <el-empty v-if="!orphans.length" description="没有孤立页" :image-size="48" />
      </aside>

      <div v-else class="kg-hint">
        {{ noLinks ? '点击节点查看详情；点「孤立」可看 orphans 清单' : '点击节点查看详情；点「孤立」可列无互链页' }}
      </div>
    </div>
    <el-empty
      v-else-if="graph"
      :description="sourceId ? `分区「${sourceLabel(sourceId)}」暂无页面` : '暂无图谱数据'"
      :image-size="64"
    />
    <el-empty v-else description="暂无图谱数据" :image-size="64" />
  </el-card>
</template>

<style scoped>
.kg-card {
  margin-top: 16px;
}

.kg-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 8px;
}

.kg-title {
  font-size: 16px;
  font-weight: 600;
  color: var(--kb-text);
}

.kg-sub {
  margin-top: 4px;
  font-size: 13px;
  color: var(--kb-text-secondary);
}

.orphan-link {
  border: 0;
  background: transparent;
  padding: 0;
  color: #dc2626;
  cursor: pointer;
  font: inherit;
  text-decoration: underline;
  text-underline-offset: 2px;
}

.orphan-link.on {
  font-weight: 600;
}

.kg-actions {
  display: flex;
  gap: 8px;
  flex-shrink: 0;
  flex-wrap: wrap;
  justify-content: flex-end;
}

.kg-legend {
  display: flex;
  flex-wrap: wrap;
  gap: 12px 16px;
  margin-bottom: 10px;
  font-size: 12px;
  color: var(--kb-text-secondary);
}

.kg-banner {
  margin-bottom: 10px;
  padding: 8px 12px;
  border-radius: 6px;
  background: #f8fafc;
  border: 1px solid #e2e8f0;
  font-size: 12px;
  line-height: 1.5;
  color: var(--kb-text-secondary);
}

.kg-banner-action,
.kg-banner-err {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
}

.kg-banner-ok {
  background: #f0fdf4;
  border-color: #bbf7d0;
  color: #166534;
}

.kg-banner-err {
  background: #fef2f2;
  border-color: #fecaca;
  color: #991b1b;
}

.kg-muted {
  margin-left: 4px;
  opacity: 0.75;
  font-weight: 400;
}

.kg-progress {
  margin-top: 6px;
  height: 4px;
  border-radius: 999px;
  background: #e2e8f0;
  overflow: hidden;
}

.kg-progress > i {
  display: block;
  height: 100%;
  background: #004898;
  border-radius: inherit;
}

.legend-item {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}

.dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  display: inline-block;
}

.dot.orphan {
  background: #f8fafc;
  box-shadow: inset 0 0 0 2px #dc2626;
}

.kg-body {
  position: relative;
  min-height: 360px;
}

.kg-chart {
  width: 100%;
  height: 420px;
  border-radius: 8px;
  background: linear-gradient(180deg, #f8fafc 0%, #eef2f7 100%);
}

.kg-panel {
  position: absolute;
  top: 12px;
  right: 12px;
  width: 240px;
  max-height: calc(100% - 24px);
  overflow: auto;
  padding: 12px 14px;
  border-radius: 8px;
  background: rgba(255, 255, 255, 0.96);
  border: 1px solid var(--kb-border, #e2e8f0);
  box-shadow: 0 8px 24px rgba(15, 23, 42, 0.08);
}

.panel-top {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 8px;
}

.panel-close {
  border: 0;
  background: transparent;
  font-size: 18px;
  line-height: 1;
  cursor: pointer;
  color: var(--kb-text-secondary);
  padding: 0 2px;
}

.preview-title {
  font-weight: 600;
  font-size: 14px;
  line-height: 1.35;
}

.preview-slug {
  margin-top: 4px;
  font-size: 12px;
  color: var(--kb-text-secondary);
  word-break: break-all;
}

.panel-tip {
  margin: 8px 0;
  font-size: 12px;
  color: var(--kb-text-secondary);
}

.kg-panel dl {
  margin: 10px 0 6px;
  display: grid;
  gap: 4px;
}

.kg-panel dl > div {
  display: flex;
  gap: 8px;
  font-size: 12px;
}

.kg-panel dt {
  width: 48px;
  flex-shrink: 0;
  color: var(--kb-text-secondary);
}

.kg-panel dd {
  margin: 0;
}

.neighbor-block {
  margin: 8px 0 10px;
}

.neighbor-title {
  font-size: 12px;
  color: var(--kb-text-secondary);
  margin-bottom: 4px;
}

.neighbor-item {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  width: 100%;
  text-align: left;
  border: 0;
  background: #f8fafc;
  border-radius: 6px;
  padding: 6px 8px;
  margin-bottom: 4px;
  cursor: pointer;
  font-size: 12px;
  color: var(--kb-text);
}

.neighbor-item:hover {
  background: #eef2f7;
}

.neighbor-item .muted {
  color: var(--kb-text-secondary);
  font-size: 11px;
  margin-top: 2px;
}

.kg-hint {
  position: absolute;
  left: 12px;
  bottom: 12px;
  font-size: 12px;
  color: var(--kb-text-secondary);
  pointer-events: none;
}

@media (max-width: 720px) {
  .kg-head {
    flex-direction: column;
  }

  .kg-panel {
    position: static;
    width: auto;
    max-height: none;
    margin-top: 12px;
  }

  .kg-chart {
    height: 320px;
  }
}
</style>
