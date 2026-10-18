<script setup lang="ts">
/**
 * 错误边界：子树渲染/生命周期抛错时兜底，避免整页白屏。
 * 路由切换自动复位；异步错误由 main.ts 的全局 errorHandler 兜底提示。
 */
import { onErrorCaptured, ref, watch } from 'vue'
import { useRoute } from 'vue-router'

const route = useRoute()
const error = ref<Error | null>(null)

onErrorCaptured((err) => {
  error.value = err instanceof Error ? err : new Error(String(err))
  console.error('[ErrorBoundary]', err)
  return false // 阻止继续向上冒泡
})

watch(
  () => route.fullPath,
  () => {
    error.value = null
  },
)

function reset() {
  error.value = null
}

function reload() {
  location.reload()
}

function displayMessage(err: Error): string {
  const ax = err as Error & { response?: { data?: { message?: string } } }
  return ax.response?.data?.message || err.message || '未知错误'
}
</script>

<template>
  <div v-if="error" class="error-boundary">
    <el-result icon="error" title="页面出现异常" :sub-title="displayMessage(error)">
      <template #extra>
        <el-button type="primary" @click="reset">重试</el-button>
        <el-button @click="reload">刷新页面</el-button>
      </template>
    </el-result>
  </div>
  <slot v-else />
</template>

<style scoped>
.error-boundary {
  height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
}
</style>
