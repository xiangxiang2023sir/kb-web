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
    <!-- 左侧品牌区：价值主张 + 带出处问答示例（窄屏隐藏） -->
    <section class="brand-pane">
      <div class="brand-copy">
        <h2>问设备、问规程，<br />每个回答都有出处</h2>
        <p class="brand-sub">
          车间 AGV 知识大脑：先检索规程资料再作答；答不了不编造，转入问题队列，由责任人解答后入库。
        </p>
        <div class="qa-demo" aria-hidden="true">
          <div class="qa-q">行走电机 F009 报警怎么复位？</div>
          <div class="qa-a">
            <p class="qa-a-text">
              先断主电，等 5 分钟直流母线放电，面板熄灭后长按 STOP/RESET 3 秒复位；若复位后反复报警，检查制动电阻接线。
            </p>
            <div class="qa-cite">
              <span class="qa-idx">[1]</span>
              <span class="qa-cite-title">变频器 F009 故障处理规程</span>
              <span class="qa-cite-tag">电气</span>
            </div>
            <div class="qa-conf">置信度：依据充分（92%）</div>
          </div>
        </div>
      </div>
    </section>

    <!-- 右侧表单区 -->
    <main class="form-pane">
      <div class="login-panel">
        <header class="brand">
          <img class="brand-logo" src="/yanfeng-logo.png" width="397" height="117" alt="延锋 Yanfeng" />
          <h1>工业知识库</h1>
          <p class="sub">上海延锋 · 工厂内部 AI 问答</p>
        </header>

        <el-form class="login-form" size="large" label-position="top" @submit.prevent="doLogin">
          <el-form-item label="工号">
            <el-input v-model="username" placeholder="如 1080040269" autofocus />
          </el-form-item>
          <el-form-item label="密码">
            <el-input v-model="password" type="password" placeholder="请输入密码" show-password />
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
      </div>
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
/* Glean app.glean.com 式分屏：左米色品牌区，右白底表单；窄屏只留表单 */
.login-page {
  display: flex;
  min-height: 100%;
  background: #fff;
}

/* ===== 左侧品牌区 ===== */
.brand-pane {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 48px 40px;
  background: #f7f5ef;
}

.brand-copy {
  max-width: 470px;
  text-align: center;
}

.brand-copy h2 {
  margin: 0;
  font-size: 27px;
  line-height: 1.4;
  font-weight: 700;
  color: #1b1b18;
  letter-spacing: 0.02em;
}

.brand-sub {
  margin: 14px auto 0;
  max-width: 400px;
  color: #73726b;
  font-size: 14px;
  line-height: 1.8;
}

.qa-demo {
  margin-top: 34px;
  padding: 22px;
  background: #f4e9d2;
  border-radius: 16px;
  display: flex;
  flex-direction: column;
  gap: 12px;
  text-align: left;
}

.qa-q {
  align-self: flex-end;
  max-width: 85%;
  padding: 8px 14px;
  background: #004898;
  color: #fff;
  font-size: 13px;
  line-height: 1.5;
  border-radius: 12px 12px 4px 12px;
}

.qa-a {
  background: #fff;
  border: 1px solid #e8e2d2;
  border-radius: 12px 12px 12px 4px;
  padding: 12px 14px;
}

.qa-a-text {
  margin: 0;
  font-size: 13px;
  line-height: 1.7;
  color: #33322d;
}

.qa-cite {
  margin-top: 10px;
  padding-top: 8px;
  border-top: 1px solid #efece2;
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  color: #6b6a60;
}

.qa-idx {
  color: #004898;
  font-weight: 600;
}

.qa-cite-tag {
  margin-left: auto;
  padding: 0 6px;
  border: 1px solid #d8d6d0;
  border-radius: 4px;
  font-size: 11px;
  line-height: 18px;
}

.qa-conf {
  margin-top: 8px;
  font-size: 12px;
  color: #3c7a4e;
}

/* ===== 右侧表单区 ===== */
.form-pane {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 32px 24px;
  padding-top: max(32px, env(safe-area-inset-top, 0px));
  padding-bottom: max(32px, env(safe-area-inset-bottom, 0px));
}

.login-panel {
  width: min(360px, 100%);
}

.brand {
  text-align: center;
  margin-bottom: 28px;
}

.brand-logo {
  display: block;
  height: 32px;
  width: auto;
  margin: 0 auto 18px;
}

h1 {
  margin: 0;
  font-size: 20px;
  font-weight: 700;
  letter-spacing: 0.08em;
  color: #1b1b18;
}

.sub {
  margin: 6px 0 0;
  color: #73726b;
  font-size: 13px;
}

.login-form :deep(.el-form-item) {
  margin-bottom: 14px;
}

.login-form :deep(.el-form-item__label) {
  color: #3c3b35;
  font-size: 13px;
  padding-bottom: 4px;
}

.login-form :deep(.el-input__wrapper) {
  border-radius: 8px;
}

.full {
  width: 100%;
}

.primary-btn {
  height: 44px;
  margin-top: 6px;
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
  margin: 18px 0 14px;
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

/* 窄屏：品牌区隐藏，表单独占（手机不滚动就能看到登录按钮） */
@media (max-width: 900px) {
  .brand-pane {
    display: none;
  }
}

@media (max-width: 480px) {
  .form-pane {
    padding: 24px 18px;
    padding-top: max(24px, env(safe-area-inset-top, 0px));
    padding-bottom: max(24px, env(safe-area-inset-bottom, 0px));
  }

  .primary-btn,
  .guest-btn {
    min-height: 44px;
  }
}
</style>
