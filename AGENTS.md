# 工厂知识库 — 给后续开发（人 / Cursor / Hermes）

拿到本仓库先读这一份。目的、架构、能改什么、不能改什么都在这里。  
人类看 README.md 也能跑起来；改代码以本文为准。

## 目的

车间用的内部系统，不是通用聊天机器人。

**现在要能：**

- 按角色和项目看知识（主人全见；管理员不见 top_secret；操作员看所在项目；游客仅公开）
- 把规程文档解析后入库到 GBrain，对话时检索再回答，并带出处
- 答不了的问题转入问题队列，由责任人解答后再入库
- 打招呼可以正常说话；问设备/规程没有资料时不要编造

**以后要形成工作流（还没做）：** 收集问题点、指派处理、发邮件通知、闭环。  
办事是程序里的明确动作（按钮或固定流水线），不是让模型在对话里随便调工具。

## 架构

```
浏览器 / 飞书  →  Vite / Nginx 或 webhook
               →  Node 后端 (127.0.0.1:3000)
                    → GBrain CLI：search / capture / orphans / frontmatter
                    → DeepSeek（或其它 OpenAI 兼容接口）：写回答、分类、闲聊
```

一个大脑、多个插座。网站 WebSocket 走 `runAsk`。外部 agent（飞书智能体 / Teams / 豆包）调 `/api/agent/ask` 拿现成答案原样转发。kb-web 自建飞书应用号不问答，只收「记一下」进待确认。

- 前端：`src/`（Vue 3 + Pinia + Element Plus）。`npm run dev` 是 Mock；`npm run dev:real` 走真实后端。
- 后端：`server/src/`（Express + WebSocket）。配置 `server/config.yaml`，密钥 `server/.env`（不要提交）。
- 知识库：本机 GBrain（PGLite）。slug 约定 `{field}/{sensitivity}/{name}`，例如 `electrical/internal/inverter-f009`。
- 权限：slug `{领域/密级/名字}` + 项目成员。主人全见；管理员不见 top_secret；操作员看所在项目；游客仅 public。外部 agent 默认按账号权限（`config.yaml` → `agent.publicOnlyOnly`，true 才只带 public/internal）。

问答固定流水线（不要改成多轮选工具的 Agent）：

1. 闲聊整句（`config.yaml` → `chat.phrases`）→ 闲聊提示词，不检索
2. 否则把去口语后的原句交给 GBrain `search`（语义；0 命中才拆词补查）→ 按登录人和项目过滤 slug
3. 有命中 → 模型只根据资料写回答（带 `[1]`）
4. 没命中 → 固定「没有资料」文案，转入问题队列；不推测

入库：上传 → `extractText()` 抽正文 → 模型建议领域/密级 → 人确认 → `gbrain capture --file --slug --force`。

## agent 写入接口（2026-10-19）

`POST /api/agent/capture`：给**不在本机/在容器里**的 agent 用的知识入库入口。
- 鉴权：网页「绑定外部 agent」下载 Skill 里的个人钥匙（`kb_…`）。没有第二套全局令牌。
- 入参：`{title, content(markdown), field?, kind?}` → **只写「待确认」**，永远不直接进正式库
- 去重：同标题返回 `duplicate:true`；密级强制 internal；内容上限 200KB
- 与网页「对话沉淀」、`server/scripts/submit-summary.ts` 三者殊途同归：都落在待确认
- 车间人：网页「绑定外部 agent」下载 `kb-web.SKILL.md` 交给智能体；一人一把钥匙，再下载旧文件作废

## 硬规则（改功能时不要破）

1. **模型只写字，不选工具、不发邮件、不改权限。** 副作用（写库、发信、改工单状态）走后端明确的路由。
2. **不要改 GBrain 源码。** 只用 CLI：`search --json`、`capture --file --slug --force`、`orphans --json`、`frontmatter validate`。
3. **密钥和本机路径不进 yaml、不进 git。** `DEEPSEEK_API_KEY`、`GBRAIN_BIN`、`FEISHU_*` 只写 `server/.env`。
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
| 飞书通道（验签、绑定、回复） | `server/src/feishu.ts`；路由在 `app.ts` 的 `/api/feishu/*` |
| 生成 / 分类 | `server/src/llm.ts`、`server/prompts/*.md` |
| 阈值、闲聊说法、检索、历史上限 | `server/config.yaml` |
| 周归档 | `server/src/archive.ts`；文件在 `server/data/archives` |
| 前端页面 | `src/views/`，接口清单 `src/api/endpoints.ts` |
| 联调假数据 | `mock/`（`npm run dev`） |

## 对话历史

每人默认只看自己的会话。主人/管理员能看全部（有提问人、来源：网页/外部）。点开别人的会话只读，仍可勾选入库或删除。外部 agent 调 `/api/agent/ask` 时带 `sessionId` 续场；不带则接最近一场（`chat.agentIdleHours`，默认 8 小时），`"new": true` 新开。周归档按 ISO 周写本机文件，不自动进正式库，网页可「送入待确认」。

## 怎么完善（给人和 Agent 的工作流）

每次只做一件能验证的事。建议顺序：

1. **先跑起来**：`server/.env.example` 复制为 `server/.env`；装 Bun + `gbrain`；`gbrain init --pglite --no-embedding`；`npm run server` 与 `npm run dev:real`。种子账号见 README。
2. **只改配置能解决的不要改代码**（检索条数、闲聊说法、提示词、密级关键词）。
3. **新文件格式**：`server/src/text.ts` 的 `extractText()` 加后缀；同步 `src/views/admin/DocUploadView.vue` 的 `ACCEPT`；有 Mock 时改 `mock/http.ts`。外部转换软件的路径放 `.env`，用 spawn 调用，不要假设用户装了 Office。
4. **新「办事」能力**（邮件、收问题点、处理闭环）按模块加，不要塞进 WebSocket 问答：
   - 谁能点、失败怎么重试、记一条审计日志
   - 模型最多起草正文；发送/改状态由路由完成
   - 邮件密钥同样进 `.env`
5. **新通道**（飞书 webhook 已做；邮件 / Teams 同结构）：
   - 不要改 `ask.ts` 流水线。外部 agent 调 `/api/agent/ask` 拿现成答案原样转发；自建 webhook 只收消息、3 秒内 HTTP 200
   - 群默认只在被 @ 时回答（`config.yaml` → `feishu.groupOnlyMention`）
   - 本机 `127.0.0.1` 收不到公网事件。飞书固定域名按下面「飞书公网回调」做；不要把 HOST 改成 `0.0.0.0`
6. **Hermes 或其它 Agent 探路时：** 可以先用 GBrain CLI 试入库、试检索，把稳定步骤写回 `extractText` / 新路由。不要让 Agent 直接当网站大脑，也不要改 GBrain 仓库。
7. **另一台电脑的 Cursor：** 克隆 https://github.com/xiangxiang2023sir/kb-web ，读本文件和 `.cursor/rules/`。本机密钥和 `GBRAIN_BIN` 各自建 `server/.env`，不要从别人机器拷贝。

## 飞书公网回调（给 Hermes / 另一台机）

在**跑知识库后端的那台机**上做，不要改问答代码。目标：飞书能 POST 到固定 `https://主机名/api/feishu/events`，流量打到本机 `http://127.0.0.1:3000`。

**不要做：** 改 `HOST=0.0.0.0`；把 Vite `5173` 打到公网；把 `cert.pem`、tunnel token、`FEISHU_*`、`*.json` 凭证提交进 git。

**人要先准备好（Agent 做不了）：**

- 一个域名，Nameserver 已切到 Cloudflare（免费套餐即可）
- Cloudflare 账号能登录
- 飞书企业自建应用：权限能收发消息，事件 `im.message.receive_v1`，Encryption Key / Verification Token 已生成

**步骤（优先控制台）：**

1. 确认 `npm run server` 已监听 `http://127.0.0.1:3000`。`server/.env` 里 `HOST=127.0.0.1`。
2. 未装则安装 `cloudflared`（Windows：`winget install -e --id Cloudflare.cloudflared`）。
3. 打开 https://one.dash.cloudflare.com/ → Networks → Tunnels → Create → Cloudflared，名字 `kb-web`。
4. 按页面给的 Windows 命令安装服务（带 token），或前台：`cloudflared tunnel run --token <TOKEN>`。token 只放本机。
5. Public Hostname：`kb.<已有域名>`，Type HTTP，URL `http://127.0.0.1:3000`。
6. 浏览器打开 `https://kb.<已有域名>/api/auth/me`，应返回 JSON（未登录 401 也算通）。
7. 飞书开放平台「请求网址」填 `https://kb.<已有域名>/api/feishu/events`，保存挑战。失败先看隧道是否在跑、后端是否在 3000。
8. `server/.env` 写 `FEISHU_APP_ID` / `FEISHU_APP_SECRET` / `FEISHU_VERIFICATION_TOKEN` / `FEISHU_ENCRYPT_KEY`，重启后端。
9. 网页登录 → 「绑定外部 agent」下载 Skill 交给智能体 → 在智能体里问已入库设备名，应原样出现知识库答案和出处。

没有域名、只想先测：`npm run tunnel`，把日志里的 `https://xxxx.trycloudflare.com/api/feishu/events` 临时填进飞书；重启会变，测通后改回固定域名。

本机命令备选：`cloudflared tunnel login` → `create kb-web` → `route dns kb-web kb.<域名>` → `%USERPROFILE%\.cloudflared\config.yml` 的 ingress 指到 `http://127.0.0.1:3000` → `npm run tunnel:named`。凭证文件不要进仓库。

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
- 同时跑 `gbrain serve`（PGLite 单写者，serve 会锁库，CLI 全部 `pglite_busy`）
- 把 kb-web 问答接到 `gbrain serve --http`（那是 MCP + OAuth，不是 REST；问答继续 CLI spawn）
- 把中文问句拆成二字组当语义查询（bge-m3 要整句）
