<script setup lang="ts">
import { ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ElMessage } from 'element-plus'
import { authApi } from '@/api/endpoints'
import { useAuthStore } from '@/stores/auth'

const auth = useAuthStore()
const route = useRoute()
const router = useRouter()

const username = ref('')
const password = ref('')
const loading = ref(false)
const error = ref('')

const regVisible = ref(false)
const regLoading = ref(false)
const regForm = ref({ employeeNo: '', name: '', password: '', title: '', department: '', note: '' })

async function doRegister() {
  if (!regForm.value.employeeNo.trim() || !regForm.value.name.trim() || regForm.value.password.length < 6 || !regForm.value.title.trim()) {
    ElMessage.warning('请填名字、岗位，密码至少 6 位')
    return
  }
  regLoading.value = true
  try {
    const r = await authApi.register({
      employeeNo: regForm.value.employeeNo.trim(),
      name: regForm.value.name.trim(),
      password: regForm.value.password,
      title: regForm.value.title.trim(),
      department: regForm.value.department.trim(),
      note: regForm.value.note.trim(),
    })
    ElMessage.success(r.message || '已提交，等管理员批准')
    regVisible.value = false
    regForm.value = { employeeNo: '', name: '', password: '', title: '', department: '', note: '' }
  } catch (err) {
    const msg = (err as { response?: { data?: { message?: string } } })?.response?.data?.message || '提交失败，请重试'
    ElMessage.error(msg)
  } finally {
    regLoading.value = false
  }
}

function target() {
  return (route.query.redirect as string) || auth.homePath
}

async function doLogin() {
  if (!username.value || !password.value) {
    error.value = '请输入工号和密码'
    return
  }
  loading.value = true
  error.value = ''
  try {
    await auth.login(username.value, password.value)
    router.push(target())
  } catch {
    error.value = '登录失败，请检查工号和密码'
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
          <el-input v-model="username" placeholder="工号（如 1080040269）" autofocus />
        </el-form-item>
        <el-form-item>
          <el-input v-model="password" type="password" placeholder="密码" show-password @keyup.enter="doLogin" />
        </el-form-item>
        <el-button type="primary" class="full" native-type="submit" :loading="loading">登录</el-button>
      </el-form>
      <el-divider class="divider">或</el-divider>
      <el-button class="full" :loading="loading" @click="doGuest">游客进入（仅公开问答）</el-button>

      <el-button class="full" text @click="regVisible = true">申请注册账号</el-button>

      <el-dialog v-model="regVisible" title="申请注册（管理员批准后可用）" width="min(440px, 92vw)">

        <el-form label-width="80px">

          <el-form-item label="工号"><el-input v-model="regForm.employeeNo" placeholder="登录用，纯数字或字母（如 1080040269）" /></el-form-item>
          <el-form-item label="姓名"><el-input v-model="regForm.name" placeholder="真实姓名，界面显示用" /></el-form-item>

          <el-form-item label="岗位"><el-input v-model="regForm.title" placeholder="如 电气设计工程师" /></el-form-item>

          <el-form-item label="部门"><el-input v-model="regForm.department" placeholder="如 技术中心" /></el-form-item>

          <el-form-item label="申请说明"><el-input v-model="regForm.note" type="textarea" :rows="2" placeholder="为什么需要访问（可选）" /></el-form-item>

          <el-form-item label="密码"><el-input v-model="regForm.password" type="password" show-password placeholder="至少 6 位" /></el-form-item>

        </el-form>

        <template #footer>

          <el-button @click="regVisible = false">取消</el-button>

          <el-button type="primary" :loading="regLoading" @click="doRegister">提交申请</el-button>

        </template>

      </el-dialog>
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
  padding: 16px;
  padding-top: max(16px, env(safe-area-inset-top, 0px));
  padding-bottom: max(16px, env(safe-area-inset-bottom, 0px));
}

.login-card {
  width: 380px;
  max-width: 100%;
}

.login-card :deep(.el-input__inner),
.login-card :deep(.el-input__wrapper input) {
  font-size: 16px;
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

@media (max-width: 480px) {
  .login-card :deep(.el-card__body) {
    padding: 18px 16px;
  }

  h1 {
    font-size: 20px;
  }

  .full {
    min-height: 44px;
  }
}
</style>
