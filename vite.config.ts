import { defineConfig, loadEnv } from 'vite'
import vue from '@vitejs/plugin-vue'
import { fileURLToPath, URL } from 'node:url'
import { mockPlugin } from './mock'

// Mock 开关优先级：shell 环境变量 > .env 文件；开发默认启用，生产默认关闭。
// 连真实后端：npm run dev:real（VITE_MOCK=0，走 proxy 到 VITE_PROXY_TARGET）。
export default defineConfig(({ command, mode }) => {
  const env = loadEnv(mode, fileURLToPath(new URL('.', import.meta.url)), 'VITE_')
  const flag = process.env.VITE_MOCK ?? env.VITE_MOCK ?? (mode === 'production' ? '0' : '1')
  const useMock = command === 'serve' && flag !== '0'
  const target = env.VITE_PROXY_TARGET || 'http://127.0.0.1:3000'

  return {
    plugins: [vue(), ...(useMock ? [mockPlugin()] : [])],
    resolve: {
      alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
    },
    server: {
      port: 5173,
      proxy: useMock
        ? undefined
        : {
            '/api': { target, changeOrigin: true },
            '/ws': { target, ws: true },
          },
    },
  }
})
