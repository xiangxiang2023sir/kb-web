<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { ElMessage } from 'element-plus'
import * as echarts from 'echarts/core'
import { GraphChart } from 'echarts/charts'
import { TooltipComponent } from 'echarts/components'
import { CanvasRenderer } from 'echarts/renderers'
import { kbApi, projectsApi, type KbGraph, type KbGraphNode, type ProjectItem } from '@/api/endpoints'

echarts.use([GraphChart, TooltipComponent, CanvasRenderer])

const FIELD_COLOR: Record<string, string> = {
  electrical: '#004898',
  dispatch: '#0d7a5f',
  mechanical: '#b45309',
}

const loading = ref(true)
const graph = ref<KbGraph | null>(null)
const keyword = ref('')
/** 空 = 全部分区；值是 GBrain sourceId */
const sourceId = ref('')
const projects = ref<ProjectItem[]>([])
const selected = ref<KbGraphNode | null>(null)
const chartEl = ref<HTMLDivElement | null>(null)
let chart: echarts.ECharts | null = null

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
  return sourceOptions.value.find((o) => o.value === id)?.label ?? id
}

async function loadProjects() {
  projects.value = await projectsApi.list().catch(() => [])
}

async function load() {
  loading.value = true
  selected.value = null
  try {
    graph.value = await kbApi.graph(sourceId.value || undefined)
    await nextTick()
    render()
  } catch {
    ElMessage.error('知识图谱加载失败')
    graph.value = null
  } finally {
    loading.value = false
  }
}

function matches(node: KbGraphNode, q: string) {
  if (!q) return true
  const hay = `${node.title} ${node.slug} ${node.field}`.toLowerCase()
  return hay.includes(q)
}

function render() {
  if (!chartEl.value || !graph.value) return
  if (!chart) {
    chart = echarts.init(chartEl.value)
    chart.on('click', (params) => {
      if (params.dataType !== 'node') return
      const data = params.data as { id?: string }
      const node = graph.value?.nodes.find((n) => n.id === data.id)
      selected.value = node ?? null
    })
  }
  const q = keyword.value.trim().toLowerCase()
  const nodes = graph.value.nodes.map((n) => {
    const hit = matches(n, q)
    const dim = Boolean(q) && !hit
    return {
      id: n.id,
      name: shortLabel(n.title, n.slug),
      value: n.degree,
      symbolSize: Math.min(42, 14 + n.degree * 5),
      category: n.field,
      itemStyle: {
        color: colorOf(n.field),
        opacity: dim ? 0.18 : 1,
        borderColor: n.orphan ? '#dc2626' : undefined,
        borderWidth: n.orphan ? 2 : 0,
      },
      label: {
        show: !dim && (n.degree >= 2 || Boolean(q && hit)),
        color: '#334155',
        fontSize: 11,
      },
      tooltip: {
        formatter: () =>
          `${n.title}<br/><span style="opacity:.7">${n.slug}</span><br/>分区 ${n.sourceId || '—'} · 领域 ${n.field} · 度 ${n.degree}${n.orphan ? ' · 孤立' : ''}`,
      },
    }
  })
  const categories = graph.value.stats.fields.map((f) => ({ name: f, itemStyle: { color: colorOf(f) } }))
  const links = graph.value.links.map((l) => ({
    source: l.source,
    target: l.target,
    lineStyle: { color: '#94a3b8', opacity: q ? 0.2 : 0.55, curveness: 0.12 },
  }))
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
        <div class="kg-sub">{{ statsLine || '加载中…' }}</div>
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
        <el-button size="small" :loading="loading" @click="load">刷新</el-button>
      </div>
    </div>

    <el-skeleton v-if="loading && !graph" :rows="6" animated />
    <div v-else-if="graph" class="kg-body">
      <div ref="chartEl" class="kg-chart" />
      <aside v-if="selected" class="kg-preview">
        <div class="preview-title">{{ selected.title }}</div>
        <div class="preview-slug">{{ selected.slug }}</div>
        <dl>
          <div><dt>分区</dt><dd>{{ sourceLabel(selected.sourceId) }}</dd></div>
          <div><dt>领域</dt><dd>{{ selected.field }}</dd></div>
          <div><dt>密级</dt><dd>{{ selected.sensitivity }}</dd></div>
          <div><dt>互链度</dt><dd>{{ selected.degree }}</dd></div>
          <div><dt>状态</dt><dd>{{ selected.orphan ? '孤立页' : '已互链' }}</dd></div>
        </dl>
        <el-button
          text
          type="primary"
          size="small"
          @click="$router.push({ path: '/admin/kb', query: { q: selected.slug, project: selected.sourceId } })"
        >
          在资料库中查看
        </el-button>
      </aside>
      <div v-else class="kg-hint">点击节点查看详情；红框为无互链的孤立页</div>
    </div>
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
  margin-bottom: 12px;
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

.kg-actions {
  display: flex;
  gap: 8px;
  flex-shrink: 0;
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

.kg-preview {
  position: absolute;
  top: 12px;
  right: 12px;
  width: 220px;
  padding: 12px 14px;
  border-radius: 8px;
  background: rgba(255, 255, 255, 0.94);
  border: 1px solid var(--kb-border, #e2e8f0);
  box-shadow: 0 8px 24px rgba(15, 23, 42, 0.08);
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

.kg-preview dl {
  margin: 10px 0 6px;
  display: grid;
  gap: 4px;
}

.kg-preview dl > div {
  display: flex;
  gap: 8px;
  font-size: 12px;
}

.kg-preview dt {
  width: 48px;
  color: var(--kb-text-secondary);
}

.kg-preview dd {
  margin: 0;
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

  .kg-preview {
    position: static;
    width: auto;
    margin-top: 12px;
  }

  .kg-chart {
    height: 320px;
  }
}
</style>
