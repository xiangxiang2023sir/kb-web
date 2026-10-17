/**
 * Mock 层 Vite 插件：开发与预览模式下生效。
 * - /api  → mock/http.ts（REST 中间件）
 * - /ws   → mock/ws.ts（WebSocket 推流）
 * 只拦截这两个前缀，其余请求（含 Vite HMR 的 WebSocket）不受影响。
 */
import type { Plugin } from 'vite'
import type { IncomingMessage } from 'node:http'
import type { Duplex } from 'node:stream'
import { mockApiMiddleware } from './http'
import { handleWsUpgrade } from './ws'
import { printMockHints } from './data'

function upgradeHandler(req: IncomingMessage, socket: Duplex, head: Buffer) {
  if ((req.url ?? '').split('?')[0] === '/ws') handleWsUpgrade(req, socket, head)
}

export function mockPlugin(): Plugin {
  return {
    name: 'kb-mock',
    configureServer(server) {
      server.middlewares.use('/api', mockApiMiddleware)
      server.httpServer?.on('upgrade', upgradeHandler)
      printMockHints()
    },
    configurePreviewServer(server) {
      server.middlewares.use('/api', mockApiMiddleware)
      server.httpServer?.on('upgrade', upgradeHandler)
    },
  }
}
