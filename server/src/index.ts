import { loadConfig } from './config.js'
import { runGBrain } from './gbrain.js'
import { start } from './app.js'

start()
  .then(async (server) => {
    console.log(`知识库后端已监听 http://127.0.0.1:${server.port}`)
    try {
      await runGBrain(loadConfig(), ['--help'], 8000)
    } catch (err) {
      console.warn(`GBrain 暂不可用：${(err as Error).message}`)
      console.warn('检索和确认入库会失败。改 server/config.yaml 里的 gbrain.command 后重启。')
    }
  })
  .catch((err) => {
    console.error(err)
    process.exit(1)
  })
