<script setup lang="ts">
import { ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useAuthStore } from '@/stores/auth'

const auth = useAuthStore()
const route = useRoute()
const router = useRouter()

const username = ref('')
const password = ref('')
const loading = ref(false)
const error = ref('')

function target() {
  return (route.query.redirect as string) || auth.homePath
}

async function doLogin() {
  if (!username.value || !password.value) {
    error.value = '请输入用户名和密码'
    return
  }
  loading.value = true
  error.value = ''
  try {
    await auth.login(username.value, password.value)
    router.push(target())
  } catch {
    error.value = '登录失败，请检查用户名和密码'
  } finally {
    loading.value = false
  }
}

async function doGuest() {
  loading.value = true
  error.value = ''
  try {
    await auth.guest()
    router.push('/chat')
  } catch {
    error.value = '进入失败，请重试'
  } finally {
    loading.value = false
  }
}
</script>

<template>
  <div class="login-page">
    <el-card class="login-card" shadow="never">
      <h1>工业知识库</h1>
      <p class="sub">工厂内部 AI 问答系统 · 回答均有出处</p>
      <el-form size="large" @submit.prevent="doLogin">
        <el-form-item>
          <el-input v-model="username" placeholder="用户名" autofocus />
        </el-form-item>
        <el-form-item>
          <el-input v-model="password" type="password" placeholder="密码" show-password @keyup.enter="doLogin" />
        </el-form-item>
        <el-button type="primary" class="full" native-type="submit" :loading="loading">登录</el-button>
      </el-form>
      <el-divider class="divider">或</el-divider>
      <el-button class="full" :loading="loading" @click="doGuest">游客进入（仅公开问答）</el-button>
      <p v-if="error" class="error">{{ error }}</p>
    </el-card>
  </div>
</template>

<style scoped>
.login-page {
  height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  background: #1f262e;
}

.login-card {
  width: 380px;
}

h1 {
  margin: 0;
  font-size: 22px;
}

.sub {
  margin: 6px 0 22px;
  color: var(--kb-text-secondary);
  font-size: 13px;
}

.full {
  width: 100%;
}

.divider {
  margin: 18px 0;
}

.error {
  color: var(--el-color-danger);
  font-size: 13px;
  margin: 12px 0 0;
}
</style>
