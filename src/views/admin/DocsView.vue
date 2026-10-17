<script setup lang="ts">
import { onMounted, reactive, ref } from 'vue'
import { useRouter } from 'vue-router'
import { adminApi } from '@/api/endpoints'
import type { DocItem, DocStatus, Field, Sensitivity } from '@/types'
import { docStatusLabels, fieldLabels, formatTime, sensitivityLabels } from '@/utils/labels'

const router = useRouter()
const list = ref<DocItem[]>([])
const total = ref(0)
const loading = ref(false)

const query = reactive<{
  keyword: string
  field?: Field
  sensitivity?: Sensitivity
  status?: DocStatus
  page: number
  size: number
}>({ keyword: '', page: 1, size: 20 })

async function load() {
  loading.value = true
  try {
    const res = await adminApi.docs({ ...query, keyword: query.keyword || undefined })
    list.value = res.list
    total.value = res.total
  } finally {
    loading.value = false
  }
}

onMounted(load)

function reload() {
  query.page = 1
  void load()
}

function openDoc(row: DocItem) {
  router.push(`/admin/docs/${row.id}`)
}

const statusTagType = (s: DocStatus) =>
  s === 'confirmed' ? 'success' : s === 'pending' ? 'warning' : ('danger' as const)
</script>

<template>
  <div class="page-card">
    <div class="filter-bar">
      <el-input v-model="query.keyword" placeholder="搜索标题" clearable style="width: 220px" @keyup.enter="reload" />
      <el-select v-model="query.field" placeholder="领域" clearable style="width: 130px">
        <el-option v-for="(label, v) in fieldLabels" :key="v" :label="label" :value="v" />
      </el-select>
      <el-select v-model="query.sensitivity" placeholder="密级" clearable style="width: 130px">
        <el-option v-for="(label, v) in sensitivityLabels" :key="v" :label="label" :value="v" />
      </el-select>
      <el-select v-model="query.status" placeholder="状态" clearable style="width: 130px">
        <el-option v-for="(label, v) in docStatusLabels" :key="v" :label="label" :value="v" />
      </el-select>
      <el-button type="primary" @click="reload">查询</el-button>
    </div>

    <el-skeleton v-if="loading && !list.length" :rows="5" animated />
    <el-table v-else v-loading="loading" :data="list" @row-click="openDoc">
      <el-table-column prop="title" label="标题" min-width="220" show-overflow-tooltip />
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
      <el-table-column label="更新时间" width="180">
        <template #default="{ row }">{{ formatTime(row.updatedAt) }}</template>
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
  </div>
</template>
