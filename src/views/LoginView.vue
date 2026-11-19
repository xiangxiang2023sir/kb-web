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
    <div class="login-atmosphere" aria-hidden="true">
      <div class="glow glow-a" />
      <div class="glow glow-b" />
      <div class="grid" />
      <div class="rail" />
    </div>

    <main class="login-panel">
      <header class="brand">
        <div class="company">
          <img
            class="company-mark"
            src="/yanfeng-wordmark.svg"
            width="168"
            height="28"
            alt="延锋 YANFENG"
          />
        </div>
        <div class="mark" aria-hidden="true">
          <span>知</span>
        </div>
        <h1>工业知识库</h1>
        <p class="sub">上海延锋 · 工厂内部 AI 问答 · 回答均有出处</p>
      </header>

      <el-form class="login-form" size="large" @submit.prevent="doLogin">
        <el-form-item>
          <el-input v-model="username" placeholder="工号（如 1080040269）" autofocus />
        </el-form-item>
        <el-form-item>
          <el-input
            v-model="password"
            type="password"
            placeholder="密码"
            show-password
            @keyup.enter="doLogin"
          />
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
.login-page {
  position: relative;
  height: 100%;
  min-height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px 16px;
  padding-top: max(24px, env(safe-area-inset-top, 0px));
  padding-bottom: max(24px, env(safe-area-inset-bottom, 0px));
  overflow: hidden;
  background: #151a21;
  color: #e8edf4;
}

.login-atmosphere {
  position: absolute;
  inset: 0;
  pointer-events: none;
}

.glow {
  position: absolute;
  border-radius: 50%;
  filter: blur(80px);
  opacity: 0.55;
}

.glow-a {
  width: min(52vw, 520px);
  height: min(52vw, 520px);
  top: -12%;
  right: -8%;
  background: radial-gradient(circle, rgba(43, 95, 217, 0.55) 0%, transparent 70%);
  animation: drift-a 18s ease-in-out infinite alternate;
}

.glow-b {
  width: min(48vw, 460px);
  height: min(48vw, 460px);
  bottom: -18%;
  left: -10%;
  background: radial-gradient(circle, rgba(56, 189, 168, 0.22) 0%, transparent 70%);
  animation: drift-b 22s ease-in-out infinite alternate;
}

.grid {
  position: absolute;
  inset: 0;
  background-image:
    linear-gradient(rgba(255, 255, 255, 0.035) 1px, transparent 1px),
    linear-gradient(90deg, rgba(255, 255, 255, 0.035) 1px, transparent 1px);
  background-size: 48px 48px;
  mask-image: radial-gradient(ellipse 70% 60% at 50% 40%, #000 20%, transparent 75%);
}

.rail {
  position: absolute;
  left: 0;
  top: 0;
  bottom: 0;
  width: 4px;
  background: linear-gradient(180deg, transparent, #2b5fd9 30%, #3aa89a 70%, transparent);
  opacity: 0.85;
}

.login-panel {
  position: relative;
  z-index: 1;
  width: min(400px, 100%);
  padding: 36px 32px 28px;
  border-radius: 14px;
  background: rgba(28, 35, 45, 0.78);
  border: 1px solid rgba(255, 255, 255, 0.1);
  box-shadow:
    0 24px 64px rgba(0, 0, 0, 0.35),
    inset 0 1px 0 rgba(255, 255, 255, 0.06);
  backdrop-filter: blur(16px);
  animation: panel-in 0.55s ease-out both;
}

.brand {
  text-align: center;
  margin-bottom: 28px;
  animation: brand-in 0.7s ease-out both;
}

.company {
  display: flex;
  justify-content: center;
  margin-bottom: 18px;
}

.company-mark {
  display: block;
  width: 168px;
  height: 28px;
  opacity: 0.92;
}

.mark {
  width: 48px;
  height: 48px;
  margin: 0 auto 14px;
  display: grid;
  place-items: center;
  border-radius: 12px;
  background: linear-gradient(145deg, #3a74ef, #2b5fd9 55%, #1e4bb8);
  box-shadow: 0 10px 24px rgba(43, 95, 217, 0.35);
  animation: mark-pop 0.8s cubic-bezier(0.22, 1, 0.36, 1) both;
}

.mark span {
  font-size: 24px;
  font-weight: 700;
  color: #fff;
  letter-spacing: 0.04em;
  line-height: 1;
}

h1 {
  margin: 0;
  font-size: 28px;
  font-weight: 700;
  letter-spacing: 0.12em;
  color: #fff;
}

.sub {
  margin: 10px 0 0;
  color: rgba(194, 202, 212, 0.88);
  font-size: 13px;
  letter-spacing: 0.02em;
  line-height: 1.5;
}

.login-form :deep(.el-form-item) {
  margin-bottom: 14px;
}

.login-form :deep(.el-input__wrapper) {
  background: rgba(15, 20, 28, 0.65);
  box-shadow: 0 0 0 1px rgba(255, 255, 255, 0.1) inset;
  border-radius: 8px;
}

.login-form :deep(.el-input__wrapper:hover),
.login-form :deep(.el-input__wrapper.is-focus) {
  box-shadow: 0 0 0 1px rgba(43, 95, 217, 0.65) inset;
}

.login-form :deep(.el-input__inner) {
  color: #e8edf4;
  font-size: 16px;
}

.login-form :deep(.el-input__inner::placeholder) {
  color: rgba(194, 202, 212, 0.55);
}

.login-form :deep(.el-input__suffix) {
  color: rgba(194, 202, 212, 0.7);
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
  background: linear-gradient(135deg, #3a74ef, #2b5fd9);
}

.primary-btn:hover {
  background: linear-gradient(135deg, #4a82f5, #3368e3);
}

.or-line {
  display: flex;
  align-items: center;
  gap: 12px;
  margin: 20px 0 16px;
  color: rgba(194, 202, 212, 0.55);
  font-size: 12px;
}

.or-line::before,
.or-line::after {
  content: '';
  flex: 1;
  height: 1px;
  background: rgba(255, 255, 255, 0.1);
}

.guest-btn {
  height: 42px;
  background: rgba(255, 255, 255, 0.04);
  border: 1px solid rgba(255, 255, 255, 0.14);
  color: #d7dee8;
}

.guest-btn:hover {
  background: rgba(255, 255, 255, 0.08);
  border-color: rgba(255, 255, 255, 0.22);
  color: #fff;
}

.register-btn {
  margin-top: 8px;
  color: rgba(194, 202, 212, 0.85);
}

.register-btn:hover {
  color: #fff;
}

.error {
  color: #f89898;
  font-size: 13px;
  margin: 14px 0 0;
  text-align: center;
}

@keyframes panel-in {
  from {
    opacity: 0;
    transform: translateY(14px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}

@keyframes brand-in {
  from {
    opacity: 0;
    transform: translateY(8px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}

@keyframes mark-pop {
  from {
    opacity: 0;
    transform: scale(0.86);
  }
  to {
    opacity: 1;
    transform: scale(1);
  }
}

@keyframes drift-a {
  from {
    transform: translate(0, 0);
  }
  to {
    transform: translate(-24px, 18px);
  }
}

@keyframes drift-b {
  from {
    transform: translate(0, 0);
  }
  to {
    transform: translate(20px, -16px);
  }
}

@media (max-width: 480px) {
  .login-panel {
    padding: 28px 20px 22px;
    border-radius: 12px;
  }

  h1 {
    font-size: 24px;
    letter-spacing: 0.1em;
  }

  .primary-btn,
  .guest-btn {
    min-height: 44px;
  }

  .rail {
    display: none;
  }
}

@media (prefers-reduced-motion: reduce) {
  .glow-a,
  .glow-b,
  .login-panel,
  .brand,
  .mark {
    animation: none;
  }
}
</style>
