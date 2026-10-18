<script setup lang="ts">
import type { ConfidenceLevel } from '@/types'

defineProps<{ level: ConfidenceLevel; score: number }>()

// 颜色 + 文字双重标识，车间环境下不依赖颜色分辨
const meta: Record<ConfidenceLevel, { label: string; type: 'success' | 'warning' | 'danger' }> = {
  high: { label: '依据充分', type: 'success' },
  medium: { label: '部分依据', type: 'warning' },
  low: { label: '依据不足', type: 'danger' },
}
</script>

<template>
  <el-tag :type="meta[level].type" effect="light">
    置信度：{{ meta[level].label }}（{{ Math.min(100, Math.max(0, Math.round(score * 100))) }}%）
  </el-tag>
</template>
