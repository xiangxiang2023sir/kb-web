import { defineStore } from 'pinia'
import { authApi } from '@/api/endpoints'
import type { User } from '@/types'

interface AuthState {
  user: User | null
  /** 是否已尝试过恢复会话（GET /auth/me） */
  ready: boolean
}

export const useAuthStore = defineStore('auth', {
  state: (): AuthState => ({ user: null, ready: false }),
  getters: {
    isAdmin: (s) => s.user?.role === 'owner' || s.user?.role === 'admin',
    /** 按角色决定登录后的默认落点：管理壳或对话壳 */
    homePath(): string {
      return this.isAdmin ? '/admin' : '/chat'
    },
  },
  actions: {
    async ensureLoaded() {
      if (this.ready) return
      try {
        this.user = await authApi.me()
      } catch {
        this.user = null
      }
      this.ready = true
    },
    async login(username: string, password: string) {
      this.user = await authApi.login(username, password)
    },
    async guest() {
      this.user = await authApi.guest()
    },
    async logout() {
      try {
        await authApi.logout()
      } finally {
        this.user = null
      }
    },
  },
})
