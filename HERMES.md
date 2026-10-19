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

## agent 日终总结（每人一个工作脑）

```bash
# ① 写进自己的工作脑（source = 这个人的私有脑，公共检索看不到）
gbrain capture --source xiaoa-work --file <总结.md> --slug electrical/internal/<日期>-小A日终总结 --quiet
# ② 提交 kb-web 待确认（确认后才进 default 正式库）
cd server && npx tsx scripts/submit-summary.ts <总结.md> "<标题>" <提交人> <领域> <source名>
# ③ 自验隔离：不带 --source 应搜不到，带 --source 才命中
gbrain search <关键词>            # 期望 No results
gbrain search <关键词> --source xiaoa-work
```

- 现有工作脑：`xiaoa-work`（小A）、`xiaoc-work`（小C）；公共库 `default` 不收未审核内容
- ⚠️ 容器/跨机里的 agent 跑不了 gbrain CLI（无 CLI、目录未挂载）⇒ 需宿主机侧执行，或后续走 kb-web 的 agent 写入接口
