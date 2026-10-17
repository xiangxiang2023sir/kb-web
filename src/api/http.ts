import axios from 'axios'
import router from '@/router'

/** REST 客户端：同源 /api，HttpOnly Cookie 鉴权 */
export const http = axios.create({
  baseURL: '/api',
  withCredentials: true,
  timeout: 30000,
})

http.interceptors.response.use(
  (res) => res,
  (err) => {
    // 会话过期：跳登录页，登录后回跳
    if (err.response?.status === 401 && router.currentRoute.value.name !== 'login') {
      router.push({ name: 'login', query: { redirect: router.currentRoute.value.fullPath } })
    }
    return Promise.reject(err)
  },
)
