<script setup lang="ts">
import { ref } from 'vue'
import { ArrowDown, ArrowRight, Document } from '@element-plus/icons-vue'
import type { Citation } from '@/types'
import { fieldLabels } from '@/utils/labels'

defineProps<{ citation: Citation; index: number }>()

const open = ref(false)
</script>

<template>
  <div class="citation" @click="open = !open">
    <div class="citation-head">
      <el-icon><Document /></el-icon>
      <span class="idx">[{{ index }}]</span>
      <span class="title">{{ citation.title }}</span>
      <el-tag size="small" effect="plain">{{ fieldLabels[citation.field] }}</el-tag>
      <el-icon class="toggle">
        <ArrowDown v-if="open" />
        <ArrowRight v-else />
      </el-icon>
    </div>
    <div v-if="open" class="citation-body">
      <p class="snippet">{{ citation.snippet }}</p>
      <p class="path">{{ citation.path }}</p>
    </div>
  </div>
</template>

<style scoped>
.citation {
  margin-top: 8px;
  border: 1px solid var(--kb-border);
  border-radius: 6px;
  background: #fafbfc;
  cursor: pointer;
}

.citation-head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 10px;
  font-size: 13px;
}

.citation-head .idx {
  color: var(--el-color-primary);
  font-weight: 600;
}

.citation-head .title {
  font-weight: 500;
}

.citation-head .toggle {
  margin-left: auto;
  color: var(--kb-text-secondary);
}

.citation-body {
  border-top: 1px solid var(--kb-border);
  padding: 8px 12px;
}

.snippet {
  margin: 0;
  line-height: 1.7;
}

.path {
  margin: 6px 0 0;
  color: var(--kb-text-secondary);
  font-size: 12px;
}
</style>
