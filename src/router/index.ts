import { createRouter, createWebHistory } from 'vue-router'
import { useAuthStore } from '@/stores/auth'
import type { Role } from '@/types'

const router = createRouter({
  history: createWebHistory(),
  routes: [
    {
      path: '/login',
      name: 'login',
      component: () => import('@/views/LoginView.vue'),
      meta: { public: true },
    },
    // 对话壳：操作员/游客默认落点（管理员也可访问）
    {
      path: '/',
      component: () => import('@/layouts/ChatLayout.vue'),
      children: [
        { path: 'chat', name: 'chat', component: () => import('@/views/chat/ChatView.vue'), meta: { title: '新对话' } },
        { path: 'chat/history', name: 'chat-history', component: () => import('@/views/chat/HistoryView.vue'), meta: { title: '历史会话' } },
        { path: 'chat/unanswered', name: 'chat-unanswered', component: () => import('@/views/chat/UnansweredView.vue'), meta: { title: '未解答问题' } },
        { path: 'chat/:id', name: 'chat-session', component: () => import('@/views/chat/ChatView.vue'), meta: { title: '会话' } },
      ],
    },
    // 管理壳：管理员/主人
    {
      path: '/admin',
      component: () => import('@/layouts/AdminLayout.vue'),
      meta: { roles: ['owner', 'admin'] as Role[] },
      children: [
        { path: '', name: 'admin-dashboard', component: () => import('@/views/admin/DashboardView.vue'), meta: { title: '总览' } },
        { path: 'docs', name: 'admin-docs', component: () => import('@/views/admin/DocsView.vue'), meta: { title: '文档列表' } },
        { path: 'docs/upload', name: 'admin-doc-upload', component: () => import('@/views/admin/DocUploadView.vue'), meta: { title: '上传文档' } },
        { path: 'docs/review', name: 'admin-doc-review', component: () => import('@/views/admin/DocReviewView.vue'), meta: { title: '待确认' } },
        { path: 'docs/:id', name: 'admin-doc-detail', component: () => import('@/views/admin/DocDetailView.vue'), meta: { title: '文档详情' } },
        { path: 'health', name: 'admin-health', component: () => import('@/views/admin/HealthView.vue'), meta: { title: '健康检查' } },
        { path: 'questions', name: 'admin-questions', component: () => import('@/views/admin/QuestionsView.vue'), meta: { title: '问题队列' } },
        { path: 'questions/:id', name: 'admin-question-detail', component: () => import('@/views/admin/QuestionDetailView.vue'), meta: { title: '问题详情' } },
        { path: 'users', name: 'admin-users', component: () => import('@/views/admin/UsersView.vue'), meta: { title: '用户管理', roles: ['owner'] as Role[] } },
      ],
    },
    { path: '/403', name: 'forbidden', component: () => import('@/views/ForbiddenView.vue') },
    { path: '/:pathMatch(.*)*', redirect: '/' },
  ],
})

router.beforeEach(async (to) => {
  const auth = useAuthStore()
  if (!auth.ready) await auth.ensureLoaded()

  // 根路径按角色分流到对应壳
  if (to.path === '/') return auth.user ? auth.homePath : { name: 'login' }

  if (to.meta.public) {
    if (auth.user && to.name === 'login') return auth.homePath
    return true
  }
  if (!auth.user) return { name: 'login', query: { redirect: to.fullPath } }

  // 权限：取匹配链上最里层声明的 roles（如 /admin/users 只允许主人）
  const withRoles = [...to.matched].reverse().find((r) => r.meta.roles)
  const need = withRoles?.meta.roles as Role[] | undefined
  if (need && !need.includes(auth.user!.role)) return { name: 'forbidden' }

  return true
})

export default router
