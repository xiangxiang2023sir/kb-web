import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import { fileURLToPath, URL } from 'node:url'
import { mockPlugin } from './mock'

// 默认启用前端 Mock（REST /api + WebSocket /ws 都由本地模拟，无需后端）。
// 连真实后端：npm run dev:real（VITE_MOCK=0，走下面的 proxy 到 127.0.0.1:3000）。
const useMock = process.env.VITE_MOCK !== '0'

export default defineConfig({
  plugins: [vue(), ...(useMock ? [mockPlugin()] : [])],
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  server: {
    port: 5173,
    proxy: useMock
      ? undefined
      : {
          '/api': { target: 'http://127.0.0.1:3000', changeOrigin: true },
          '/ws': { target: 'ws://127.0.0.1:3000', ws: true },
        },
  },
})
