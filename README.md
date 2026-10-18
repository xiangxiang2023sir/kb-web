# 工厂知识库

车间内部系统：按权限检索规程、问答带出处、答不了的进问题队列。  
设计说明和以后怎么改，以 **[AGENTS.md](./AGENTS.md)** 为准（人也读、Cursor / Hermes 也读）。

仓库：https://github.com/xiangxiang2023sir/kb-web

## 本机运行

需要：Node 24+、本机已装 [GBrain](https://github.com/garrytan/gbrain)（Windows 先装 [Bun](https://bun.sh)）。

```bash
# 1. 后端密钥（不要提交）
copy server\.env.example server\.env
# 填写 DEEPSEEK_API_KEY；gbrain 不在 PATH 时填 GBRAIN_BIN

# 2. 本机知识库（只需一次）
gbrain init --pglite --no-embedding

# 3. 依赖
npm install
npm --prefix server install

# 4. 两个终端
npm run server
npm run dev:real
```

- 前端：http://localhost:5173  
- 后端：http://127.0.0.1:3000  
- 仅看界面、不接真库：`npm run dev`（Mock）

可调参数在 `server/config.yaml` 和 `server/prompts/`，改完重启后端。

## 飞书

本机 `127.0.0.1:3000` 收不到飞书的公网回调，需要已有 HTTPS 域名反代到后端，或内网穿透。

1. 飞书开放平台建企业自建应用，开通收发消息权限，订阅事件 `im.message.receive_v1`
2. 请求网址填 `https://你的域名/api/feishu/events`
3. 把 `FEISHU_APP_ID`、`FEISHU_APP_SECRET`、`FEISHU_VERIFICATION_TOKEN`、`FEISHU_ENCRYPT_KEY` 写入 `server/.env`
4. 网页登录 → 侧栏「绑定飞书」→ 对机器人发送 `绑定 ABC123`

群里默认只在 @机器人 时回答。管理端「飞书绑定」可查看和解绑。

## 种子账号

| 用户 | 密码 | 角色 |
|---|---|---|
| owner | admin123 | 主人 |
| admin | admin123 | 管理员 |
| wang | 123456 | 操作员 · 电气 |
| li | 123456 | 操作员 · 机械 |
| zhao | 123456 | 操作员 · 调度 |

## 验证

```bash
npm --prefix server test
npm --prefix server run typecheck
npm run build
```
