<script setup lang="ts">
import { onMounted, onUnmounted, ref } from 'vue'
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

// ---- 左侧品牌区轮播 ----
const slides = [
  {
    title: '准确性 · 答必有据',
    sub: '回答先检索规程资料，逐条附出处、可核对原文；没有依据就明说没有，不编造。',
    img: '/login/slide-accuracy.jpg',
  },
  {
    title: '保密性 · 分级管控',
    sub: '公开 / 内部 / 机密 / 绝密四级密级，按角色与项目成员过滤，越级看不到。',
    img: '/login/slide-security.jpg',
  },
  {
    title: '可接入性 · 接口开放',
    sub: '问答接口对外开放：飞书、豆包、Cursor 等多个 Agent 都能接入，一个大脑多处复用。',
    img: '/login/slide-connect.jpg',
  },
]
const slideIdx = ref(0)
let slideTimer: ReturnType<typeof setInterval> | undefined
onMounted(() => {
  slideTimer = setInterval(() => {
    slideIdx.value = (slideIdx.value + 1) % slides.length
  }, 5000)
})
onUnmounted(() => {
  if (slideTimer) clearInterval(slideTimer)
})

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
    <!-- 左侧品牌区：轮播价值主张（窄屏隐藏） -->
    <section class="brand-pane">
      <div class="brand-copy">
        <Transition name="slide-fade" mode="out-in">
          <div :key="slideIdx" class="slide">
            <img class="slide-bg" :src="slides[slideIdx].img" alt="" aria-hidden="true" />
            <div class="slide-veil" />
            <h2>{{ slides[slideIdx].title }}</h2>
            <p class="brand-sub">{{ slides[slideIdx].sub }}</p>
          </div>
        </Transition>

        <div class="dots">
          <button
            v-for="(s, i) in slides"
            :key="i"
            type="button"
            class="dot"
            :class="{ on: i === slideIdx }"
            :aria-label="`第 ${i + 1} 页`"
            @click="slideIdx = i"
          />
        </div>
      </div>
    </section>

    <!-- 右侧表单区 -->
    <main class="form-pane">
      <div class="login-panel">
        <img class="brand-logo" src="/yanfeng-logo.png" width="397" height="117" alt="延锋 Yanfeng" />
        <h1 class="product-name">IMC 工业知识库</h1>

        <el-form class="login-form" size="large" label-position="top" @submit.prevent="doLogin">
          <el-form-item label="工号">
            <el-input v-model="username" placeholder="请输入工号" autofocus />
          </el-form-item>
          <el-form-item label="密码">
            <el-input v-model="password" type="password" placeholder="请输入密码" show-password />
          </el-form-item>
          <el-button type="primary" class="full primary-btn" native-type="submit" :loading="loading">
            登录
          </el-button>
        </el-form>

        <div class="login-links">
          <el-button text class="link-btn" :loading="loading" @click="doGuest">游客进入</el-button>
          <el-button text class="link-btn" @click="regVisible = true">申请注册账号</el-button>
        </div>

        <p v-if="error" class="error" role="alert">{{ error }}</p>
      </div>
    </main>

    <el-dialog v-model="regVisible" title="申请注册（管理员批准后可用）" width="min(440px, 92vw)">
      <el-form label-width="80px">
        <el-form-item label="工号">
          <el-input v-model="regForm.employeeNo" placeholder="登录用，纯数字或字母" />
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
/* Glean app.glean.com 式分屏：左米色轮播品牌区，右白底极简表单；窄屏只留表单 */
.login-page {
  display: flex;
  min-height: 100%;
  background: #fff;
}

/* ===== 左侧品牌区 ===== */
.brand-pane {
  position: relative;
  overflow: hidden;
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 48px 40px;
  background: #f7f5ef;
}

/* 注意：这里不能加 position，否则 .slide-bg 的绝对定位会锚在小盒子上而不是整栏 */
.brand-copy {
  width: 100%;
  max-width: 470px;
  text-align: center;
}

/* 大图铺满左侧当背景，上面盖一层米色柔光保证文字可读 */
.slide-bg {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  object-fit: cover;
  z-index: 0;
}

.slide-veil {
  position: absolute;
  inset: 0;
  z-index: 1;
  background: linear-gradient(
    180deg,
    rgba(247, 245, 239, 0.88) 0%,
    rgba(247, 245, 239, 0.42) 40%,
    rgba(247, 245, 239, 0.3) 72%,
    rgba(247, 245, 239, 0.5) 100%
  );
  pointer-events: none;
}

.slide h2 {
  position: relative;
  z-index: 2;
  margin: 0;
  font-size: 27px;
  line-height: 1.4;
  font-weight: 700;
  color: #1b1b18;
  letter-spacing: 0.02em;
}

.brand-sub {
  position: relative;
  z-index: 2;
  margin: 14px auto 0;
  max-width: 400px;
  color: #4f4e48;
  font-size: 14px;
  line-height: 1.8;
  min-height: 50px;
}

/* 轮播切换动画与圆点 */
/* 只淡入淡出：transform 会让绝对定位的背景图改锚小盒子（切换时"先缩小"的原因） */
.slide-fade-enter-active,
.slide-fade-leave-active {
  transition: opacity 0.35s ease;
}

.slide-fade-enter-from,
.slide-fade-leave-to {
  opacity: 0;
}

.dots {
  position: absolute;
  z-index: 2;
  left: 0;
  right: 0;
  bottom: 28px;
  display: flex;
  justify-content: center;
  gap: 8px;
}

.dot {
  width: 8px;
  height: 8px;
  padding: 0;
  border: 0;
  border-radius: 50%;
  background: #d5d0c2;
  cursor: pointer;
  transition: background 0.2s ease;
}

.dot.on {
  background: #004898;
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

.brand-logo {
  display: block;
  height: 34px;
  width: auto;
  margin: 0 auto 14px;
}

.product-name {
  margin: 0 0 30px;
  font-size: 17px;
  font-weight: 600;
  letter-spacing: 0.06em;
  color: #1b1b18;
  text-align: center;
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

.login-links {
  margin-top: 12px;
  display: flex;
  justify-content: space-between;
  align-items: center;
}

.link-btn {
  color: #73726b;
  font-size: 13px;
}

.link-btn:hover {
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

  .primary-btn {
    min-height: 44px;
  }
}

@media (prefers-reduced-motion: reduce) {
  .slide-fade-enter-active,
  .slide-fade-leave-active,
  .dot {
    transition: none;
  }
}
</style>
