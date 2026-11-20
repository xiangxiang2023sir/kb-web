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
    <main class="login-panel">
      <header class="brand">
        <img class="brand-logo" src="/yanfeng-logo.png" width="397" height="117" alt="延锋 Yanfeng" />
        <h1>工业知识库</h1>
        <p class="sub">上海延锋 · 工厂内部 AI 问答 · 回答均有出处</p>
      </header>

      <el-form class="login-form" size="large" @submit.prevent="doLogin">
        <el-form-item>
          <el-input v-model="username" placeholder="工号（如 1080040269）" autofocus />
        </el-form-item>
        <el-form-item>
          <el-input v-model="password" type="password" placeholder="密码" show-password />
        </el-form-item>
        <el-button type="primary" class="full primary-btn" native-type="submit" :loading="loading">
          登录
        </el-button>
      </el-form>

      <div class="or-line"><span>或</span></div>

      <el-button class="full guest-btn" :loading="loading" @click="doGuest">
        游客进入（仅公开问答）
      </el-button>

      <el-button class="full register-btn" text @click="regVisible = true">申请注册账号</el-button>

      <p v-if="error" class="error" role="alert">{{ error }}</p>
    </main>

    <el-dialog v-model="regVisible" title="申请注册（管理员批准后可用）" width="min(440px, 92vw)">
      <el-form label-width="80px">
        <el-form-item label="工号">
          <el-input v-model="regForm.employeeNo" placeholder="登录用，纯数字或字母（如 1080040269）" />
        </el-form-item>
        <el-form-item label="姓名">
          <el-input v-model="regForm.name" placeholder="真实姓名，界面显示用" />
        </el-form-item>
        <el-form-item label="岗位">
          <el-input v-model="regForm.title" placeholder="如 电气设计工程师" />
        </el-form-item>
        <el-form-item label="部门">
          <el-input v-model="regForm.department" placeholder="如 技术中心" />
        </el-form-item>
        <el-form-item label="申请说明">
          <el-input v-model="regForm.note" type="textarea" :rows="2" placeholder="为什么需要访问（可选）" />
        </el-form-item>
        <el-form-item label="密码">
          <el-input v-model="regForm.password" type="password" show-password placeholder="至少 6 位" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="regVisible = false">取消</el-button>
        <el-button type="primary" :loading="regLoading" @click="doRegister">提交申请</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<style scoped>
/* Glean 式：纸感浅底 + 白卡片 + 黑字，品牌蓝只给主操作 */
.login-page {
  min-height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px 16px;
  padding-top: max(24px, env(safe-area-inset-top, 0px));
  padding-bottom: max(24px, env(safe-area-inset-bottom, 0px));
  background: #f7f6f3;
}

.login-panel {
  width: min(400px, 100%);
  padding: 40px 36px 30px;
  background: #fff;
  border: 1px solid #e8e6e0;
  border-radius: 14px;
}

.brand {
  text-align: center;
  margin-bottom: 26px;
}

.brand-logo {
  display: block;
  height: 34px;
  width: auto;
  margin: 0 auto 22px;
}

h1 {
  margin: 0;
  font-size: 22px;
  font-weight: 700;
  letter-spacing: 0.08em;
  color: #1b1b18;
}

.sub {
  margin: 8px 0 0;
  color: #73726b;
  font-size: 13px;
  line-height: 1.5;
}

.login-form :deep(.el-form-item) {
  margin-bottom: 14px;
}

.login-form :deep(.el-input__wrapper) {
  border-radius: 8px;
}

.full {
  width: 100%;
}

.primary-btn {
  height: 44px;
  margin-top: 4px;
  font-weight: 600;
  letter-spacing: 0.08em;
  border: none;
  background: #004898;
}

.primary-btn:hover,
.primary-btn:focus {
  background: #003a7c;
}

.or-line {
  display: flex;
  align-items: center;
  gap: 12px;
  margin: 20px 0 16px;
  color: #a3a19a;
  font-size: 12px;
}

.or-line::before,
.or-line::after {
  content: '';
  flex: 1;
  height: 1px;
  background: #e8e6e0;
}

.guest-btn {
  height: 42px;
  background: #fff;
  border: 1px solid #d8d6d0;
  color: #1b1b18;
}

.guest-btn:hover {
  background: #f4f3ef;
  border-color: #c9c7c0;
  color: #1b1b18;
}

.register-btn {
  margin-top: 8px;
  color: #73726b;
}

.register-btn:hover {
  color: #004898;
}

.error {
  color: #c45656;
  font-size: 13px;
  margin: 14px 0 0;
  text-align: center;
}

@media (max-width: 480px) {
  .login-panel {
    padding: 30px 20px 24px;
    border-radius: 12px;
  }

  .primary-btn,
  .guest-btn {
    min-height: 44px;
  }
}
</style>
