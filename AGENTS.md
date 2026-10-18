# 工厂知识库 — 给后续开发（人 / Cursor / Hermes）

拿到本仓库先读这一份。目的、架构、能改什么、不能改什么都在这里。  
人类看 README.md 也能跑起来；改代码以本文为准。

## 目的

车间用的内部系统，不是通用聊天机器人。

**现在要能：**

- 按角色看知识（主人 / 管理员 / 操作员按领域 / 游客仅公开）
- 把规程文档解析后入库到 GBrain，对话时检索再回答，并带出处
- 答不了的问题转入问题队列，由责任人解答后再入库
- 打招呼可以正常说话；问设备/规程没有资料时不要编造

**以后要形成工作流（还没做）：** 收集问题点、指派处理、发邮件通知、闭环。  
办事是程序里的明确动作（按钮或固定流水线），不是让模型在对话里随便调工具。

## 架构

```
浏览器  →  Vite / Nginx
         →  Node 后端 (127.0.0.1:3000)
              → GBrain CLI：search / capture / orphans / frontmatter
              → DeepSeek（或其它 OpenAI 兼容接口）：写回答、分类、闲聊
```

- 前端：`src/`（Vue 3 + Pinia + Element Plus）。`npm run dev` 是 Mock；`npm run dev:real` 走真实后端。
- 后端：`server/src/`（Express + WebSocket）。配置 `server/config.yaml`，密钥 `server/.env`（不要提交）。
- 知识库：本机 GBrain（PGLite）。slug 约定 `{field}/{sensitivity}/{name}`，例如 `electrical/internal/inverter-f009`。
- 权限：按 slug 前缀过滤。主人全见；管理员不见 top_secret；操作员仅本领域；游客仅 public。

问答固定流水线（不要改成多轮选工具的 Agent）：

1. 闲聊整句（`config.yaml` → `chat.phrases`）→ 闲聊提示词，不检索
2. 否则 GBrain `search` → 按登录人过滤 slug
3. 有命中 → 模型只根据资料写回答（带 `[1]`）
4. 没命中 → 固定「没有资料」文案，转入问题队列；不推测

入库：上传 → `extractText()` 抽正文 → 模型建议领域/密级 → 人确认 → `gbrain capture --file --slug --force`。

## 硬规则（改功能时不要破）

1. **模型只写字，不选工具、不发邮件、不改权限。** 副作用（写库、发信、改工单状态）走后端明确的路由。
2. **不要改 GBrain 源码。** 只用 CLI：`search --json`、`capture --file --slug --force`、`orphans --json`、`frontmatter validate`。
3. **密钥和本机路径不进 yaml、不进 git。** `DEEPSEEK_API_KEY`、`GBRAIN_BIN` 只写 `server/.env`。
4. **GBrain 用参数数组 spawn，禁止拼进 shell。** 见 `server/src/gbrain.ts`。
5. **slug 即权限。** 新文档必须 `领域/密级/名字`；检索结果按登录人丢掉不能看的。
6. **可调参数放 `server/config.yaml` 或 `prompts/`，** 不要为改一句提示词去改 TS。
7. **先验证再提交：** 根目录 `npm run build`，后端 `npm --prefix server test`。UI 改过要在浏览器走相关页面。

## 目录（改哪里）

| 要动的事 | 文件 |
|---|---|
| 问答流水线 | `server/src/ask.ts` |
| 抽文档正文、文件名编码、闲聊判定 | `server/src/text.ts` |
| GBrain 包装 | `server/src/gbrain.ts` |
| 权限 | `server/src/access.ts` |
| HTTP / 上传确认 / 队列 | `server/src/app.ts` |
| 生成 / 分类 | `server/src/llm.ts`、`server/prompts/*.md` |
| 阈值、闲聊说法、检索 | `server/config.yaml` |
| 前端页面 | `src/views/`，接口清单 `src/api/endpoints.ts` |
| 联调假数据 | `mock/`（`npm run dev`） |

## 怎么完善（给人和 Agent 的工作流）

每次只做一件能验证的事。建议顺序：

1. **先跑起来**：`server/.env.example` 复制为 `server/.env`；装 Bun + `gbrain`；`gbrain init --pglite --no-embedding`；`npm run server` 与 `npm run dev:real`。种子账号见 README。
2. **只改配置能解决的不要改代码**（检索条数、闲聊说法、提示词、密级关键词）。
3. **新文件格式**：`server/src/text.ts` 的 `extractText()` 加后缀；同步 `src/views/admin/DocUploadView.vue` 的 `ACCEPT`；有 Mock 时改 `mock/http.ts`。外部转换软件的路径放 `.env`，用 spawn 调用，不要假设用户装了 Office。
4. **新「办事」能力**（邮件、收问题点、处理闭环）按模块加，不要塞进 WebSocket 问答：
   - 谁能点、失败怎么重试、记一条审计日志
   - 模型最多起草正文；发送/改状态由路由完成
   - 邮件密钥同样进 `.env`
5. **Hermes 或其它 Agent 探路时：** 可以先用 GBrain CLI 试入库、试检索，把稳定步骤写回 `extractText` / 新路由。不要让 Agent 直接当网站大脑，也不要改 GBrain 仓库。
6. **另一台电脑的 Cursor：** 克隆 https://github.com/xiangxiang2023sir/kb-web ，读本文件和 `.cursor/rules/`。本机密钥和 `GBRAIN_BIN` 各自建 `server/.env`，不要从别人机器拷贝。

## 验证

- 后端：`npm --prefix server test`、`npm --prefix server run typecheck`
- 前端：根目录 `npm run build`
- 改了 UI：用真实账号走一遍相关页（登录、上传、确认、对话、问题队列）
- 改了检索/问答：至少测「你好」走闲聊、问已入库设备名有出处、无关问题走「没有资料」

## 不要做的方向

- 把对话改成多轮 function-calling，让模型自己决定检索还是发邮件
- 把 parseJson / 检索词用「逐行修 JSON」这类脆弱逻辑
- 为了多格式把 Word/Excel 解析交给未约束的 Agent 作为默认入库
- 提交 `server/.env`、`server/data/`
