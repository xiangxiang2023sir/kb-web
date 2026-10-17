/// <reference types="vite/client" />

/** .env 中可用的 VITE_* 变量（见根目录 .env / .env.development / .env.production） */
interface ImportMetaEnv {
  /** 1=启用内置 Mock；0=走真实后端（vite.config.ts 消费，不进客户端代码） */
  readonly VITE_MOCK?: string
  /** REST 接口前缀，默认 /api */
  readonly VITE_API_BASE?: string
  /** WebSocket 绝对地址覆盖，默认同源 /ws */
  readonly VITE_WS_URL?: string
  /** VITE_MOCK=0 时 dev proxy 的后端地址（vite.config.ts 消费） */
  readonly VITE_PROXY_TARGET?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
