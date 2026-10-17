import { createApp } from 'vue'
import { createPinia } from 'pinia'
import ElementPlus, { ElMessage } from 'element-plus'
import zhCn from 'element-plus/es/locale/lang/zh-cn'
import 'element-plus/dist/index.css'
import '@/styles/index.css'
import App from './App.vue'
import router from './router'

const app = createApp(App)
app.use(createPinia())
app.use(router)
app.use(ElementPlus, { locale: zhCn })

// 组件树内错误由 ErrorBoundary 兜底展示；走到这里的多为异步/事件回调里的错误，轻提示即可
app.config.errorHandler = (err, _instance, info) => {
  console.error('[GlobalError]', err, info)
  ElMessage.error('操作出现异常，请重试')
}
window.addEventListener('unhandledrejection', (e) => {
  console.error('[UnhandledRejection]', e.reason)
})

app.mount('#app')
