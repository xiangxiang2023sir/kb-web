# 给 Hermes / 其它 Agent 的施工守则

**先读 `AGENTS.md`**（功能、架构、硬规则都在那儿）。本文只管一件事：**怎么改代码而不把程序改坏**。

## 五条铁律

1. **一次只做一件事，一件事一个 commit。** 大改先开 `feat/xxx` 分支，`master` 永远可跑。
2. **提交前必须 `npm run verify` 全绿**（typecheck + 后端 test + 前端 build）。没绿不许提交。
3. **只改必要的文件。** 改完给主人 `git diff --stat` + 关键 diff 说明；别顺手重构相邻代码。
4. **不留垃圾。** 不给仓库添加临时脚本、调试日志、备份文件；临时文件放 `/tmp`，用完删。
5. **不擅自加依赖。** 确实需要时先说明理由和替代方案。

## 密钥与数据

- 密钥/本机路径**只进 `server/.env`**（已 gitignore）：`DEEPSEEK_API_KEY`、`GBRAIN_BIN`、`FEISHU_*`、`HERMES_API_KEY`。
- **不进 git**：`server/.env`、`server/data/`、`dist/`、`server/run.log`。
- 文档、示例配置里一律写占位符，不写真实 key / 域名 / 账号。

## 不要碰的边界

- 问答流水线语义（`server/src/ask.ts` 的既有顺序：闲聊 → 检索 → 过滤 → 生成 → 无资料转队列）。
- slug 权限规则（`领域/密级/名字`，`access.ts`）。
- GBrain 源码（只用 CLI）。
- 管理端「AI知识库管理助手」是**管理工具**，不是用户问答链路 —— 两套别混。

## 两个踩过的坑（务必）

- **Express 路由要写在 `/api` 兜底 `app.use('/api', …404…)` 之前**，否则永远返回「未实现」。
- **`pkill -f "tsx src/index.ts"` 会杀掉自己这条命令**；改用 PID 或 `systemctl --user restart kb-web`。

## 后端/前端改动位置

| 要动的事 | 文件 |
|---|---|
| 问答流水线 / 重排 | `server/src/ask.ts`、`server/src/gbrain.ts` |
| HTTP 路由 | `server/src/app.ts`（放 `/api` 兜底之前） |
| 小A 对话（管理端） | `server/src/hermes.ts` + `app.ts` 的 `/api/admin/assistant/chat` |
| 可调参数 | `server/config.yaml`、`server/prompts/*.md` |
| 前端接口 | `src/api/endpoints.ts` |
| 管理端页面 | `src/views/admin/*.vue`，路由 `src/router/index.ts`，菜单 `src/layouts/AdminLayout.vue` |

## 提交与回滚

```bash
git status --short          # 先看清跟哪些文件有关（别把别人的 WIP 混进自己的 commit）
npm run verify              # 必须绿
git add <改动文件> && git commit -m "feat: ..."

git checkout <commit> -- 文件   # 单文件回退
git revert <commit>            # 整次回滚
```

## 运行与排障（本机）

```bash
systemctl --user status|restart kb-web     # 后端（127.0.0.1:3000，开机自启）
journalctl --user -u kb-web -n 50          # 后端日志
curl -s http://127.0.0.1:3000/api/auth/me  # 未登录应 401（通）
```

## 每人一个工作脑：日结 / 经验条目 / 清理

**分工三条铁律**
1. **日结只是原料**，落自己的工作脑（source），**不提交** kb-web、**不进公共库**
2. 公共库只收**提炼过的经验条目**（一天 ≤3 条，四段式）
3. 过期日结**自动清理**（默认保留 30 天）

```bash
# ① 日结：简短（≤15 行/400 字），slug 固定 daily/<YYYY-MM-DD>-<agent>
gbrain capture --source xiaoa-work --file <日结.md> --slug daily/2026-10-19-xiaoa --quiet

# ② 经验条目：四段式（适用前提/现象/结论做法/证据），走 kb-web 待确认
curl -X POST http://127.0.0.1:3000/api/agent/capture \
  -H 'Authorization: Bearer <token>' -H 'Content-Type: application/json' \
  -d '{"title":"…","content":"…","kind":"经验","field":"electrical"}'

# ③ 清理（每周日 03:10 自动跑，也可手动；默认 dry-run）
server/scripts/daily-cleanup-all.sh 30            # 预览
server/scripts/daily-cleanup-all.sh 30 --apply    # 真删
systemctl --user list-timers kb-daily-cleanup.timer
```

- 模板（硬约束）：`server/prompts/daily-summary.md`
- 工作脑必须是 **git 仓库**（`gbrain sync --source <id>` 依赖它）：新机器上 `git init` 一次即可
- 「日结不再进待确认」：`server/scripts/submit-summary.ts` 只用于**经验条目**

## agent 写入接口（跨机 / 容器里的 agent 用这个）

不用装 gbrain CLI，也不要用网页登录态。用网页「绑定外部 agent」下载的个人钥匙（`kb_…`）。全局 `AGENT_TOKENS` 已停用。

```bash
curl -X POST http://<kb-web 地址>/api/agent/capture \
  -H 'Content-Type: application/json' \
  -H 'Authorization: Bearer <该 agent 的 token>' \
  -d '{"title":"2026-10-19 日终总结","content":"<markdown 正文>","field":"dispatch","kind":"日终总结"}'
```

- 返回 `{ok:true,id,status:"pending"}` —— **永远进「待确认」**，人确认后才进正式库
- 同标题自动去重（返回 `duplicate:true`）
- 密级强制 `internal`（要更高密级由人在待确认里改）；内容上限 200KB
- 容器里访问宿主机后端：`http://172.17.0.1:3000`（docker 默认网桥网关）

## 容器里的 agent 怎么连（docker 网桥转发）

kb-web 按规矩只绑 `127.0.0.1:3000`，容器经 docker0 网关进不来。用一个只绑网桥的转发解决：

- 脚本：`server/scripts/docker-bridge.py`（Python 标准库，无依赖）
- 服务：`kb-web-bridge.service`（user 级，开机自启，随 kb-web 重启）
  ```bash
  systemctl --user status kb-web-bridge     # 看状态
  ss -lnt | grep 3000                       # 应有 127.0.0.1:3000（kb-web）和 172.17.0.1:3000（桥）
  ```
- 容器内访问：`http://172.17.0.1:3000`（实测 `docker exec` 里 curl 通）
- 安全性：只监听 docker0 网桥地址，**局域网和公网都到不了**；kb-web 的绑定没变（仍是 127.0.0.1）

## 外部 agent 接入（飞书智能体 / Teams Copilot / 豆包 / 元宝）

**分工**：知识库按网页同一套流水线写好答案；外部 agent 只原样转发，不自己组织。

**① 网页下载 Skill（一人一把钥匙）**

网页登录 →「绑定外部 agent」→ 下载 `kb-web.SKILL.md`，整份交给飞书智能体 / 豆包 / Cursor。文件里有地址、个人钥匙、怎么提问、怎么提交经验。再下载会使旧文件立刻失效。

**② 提问（Skill 里的钥匙）**
```bash
curl -X POST http://127.0.0.1:3000/api/agent/ask \
  -H 'Authorization: Bearer kb_<个人钥匙>' -H 'Content-Type: application/json' \
  -d '{"query":"行走电机 maxRPM","sessionId":"<上次返回的，可省略>"}'
# → {ok, user, sessionId, answer, phase, citations}
# 把 answer 原样发给用户；不要改写。对外只含 public/internal。
# 不带 sessionId 也会接到最近一场外部会话（空闲超过 8 小时或 "new":true 会新开）。
```

**安全口径**
- 车间每人一把 `kb_` 钥匙（写在 Skill 里）；没有第二套全局令牌
- 没有钥匙或钥匙已作废一律 401，不会退化成匿名可查
- 内容出网分级：对外部云平台只放 public/internal
- kb-web 自建飞书应用号不再问答，只提示用智能体；「记一下」仍可进待确认

## 飞书里提交经验/日报

- **kb-web 自己的飞书应用**（`server/.env` 的 `FEISHU_*`）配好后，在飞书里发：
  「记一下：<内容>」或「日报：<内容>」→ 直接进「待确认」，管理员确认后才入正式库
- **小A 的飞书机器人**（Hermes）走 `/api/agent/capture`，脚本：`~/agents/小A/工具/kb_submit.py`
- 两者都只写待确认，且都做同标题去重
