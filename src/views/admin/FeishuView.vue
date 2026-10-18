<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { adminApi } from '@/api/endpoints'
import type { FeishuBinding } from '@/types'
import { formatTime } from '@/utils/labels'

const list = ref<FeishuBinding[]>([])
const loading = ref(false)

async function load() {
  loading.value = true
  try {
    list.value = await adminApi.feishuBindings()
  } catch {
    ElMessage.error('绑定名单加载失败')
  } finally {
    loading.value = false
  }
}

onMounted(load)

async function unbind(row: FeishuBinding) {
  try {
    await ElMessageBox.confirm(`解除 ${row.userName} 的飞书绑定？`, '解绑', { type: 'warning' })
  } catch {
    return
  }
  try {
    await adminApi.unbindFeishu(row.openId)
    ElMessage.success('已解绑')
    void load()
  } catch {
    ElMessage.error('解绑失败，请重试')
  }
}
</script>

<template>
  <div class="page-card">
    <p class="hint">车间同事在网页点「绑定飞书」，再对机器人发送验证码。解绑后需重新绑定才能在飞书提问。</p>
    <el-skeleton v-if="loading && !list.length" :rows="5" animated />
    <el-table v-else v-loading="loading" :data="list">
      <el-table-column prop="userName" label="用户" min-width="140" />
      <el-table-column prop="openId" label="飞书 open_id" min-width="220" />
      <el-table-column label="绑定时间" width="200">
        <template #default="{ row }">{{ formatTime(row.boundAt) }}</template>
      </el-table-column>
      <el-table-column label="操作" width="120">
        <template #default="{ row }">
          <el-button size="small" @click="unbind(row)">解绑</el-button>
        </template>
      </el-table-column>
    </el-table>
  </div>
</template>

<style scoped>
.hint {
  margin: 0 0 16px;
  color: var(--kb-text-secondary);
  line-height: 1.6;
}
</style>
