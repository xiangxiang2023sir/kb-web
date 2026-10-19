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

飞书开放平台只能往**公网 HTTPS** 推事件。本机 `127.0.0.1:3000`、车间网段 `192.168.x` 都收不到。后端继续只监听本机；用 Cloudflare Tunnel 把 `/api/feishu/events` 送出去。不要把 `HOST` 改成 `0.0.0.0`。

### 固定域名（推荐，URL 不变）

在**跑后端的那台机**上做（给 Hermes 的逐条清单见 `AGENTS.md`「飞书公网回调」）。前提：有一个域名，Nameserver 已经切到 Cloudflare。

**做法 A：控制台（少踩坑）**

1. 打开 [Cloudflare Zero Trust → Tunnels](https://one.dash.cloudflare.com/) → Create a tunnel → Cloudflared → 名字填 `kb-web`
2. 选 Windows，复制并运行它给的 `cloudflared.exe service install <TOKEN>`（或本机前台跑 `cloudflared tunnel run --token <TOKEN>`）
3. Public Hostname：例如 `kb.你的域名.com`，Type `HTTP`，URL `http://127.0.0.1:3000`
4. 飞书请求网址填：`https://kb.你的域名.com/api/feishu/events`

**做法 B：本机命令**

```bash
cloudflared tunnel login
cloudflared tunnel create kb-web
cloudflared tunnel route dns kb-web kb.你的域名.com
```

在 `%USERPROFILE%\.cloudflared\config.yml` 写（UUID 以 `tunnel create` 输出为准，不要提交进 git）：

```yaml
tunnel: <TUNNEL-UUID>
credentials-file: C:\Users\你的用户名\.cloudflared\<TUNNEL-UUID>.json
ingress:
  - hostname: kb.你的域名.com
    service: http://127.0.0.1:3000
  - service: http_status:404
```

后端起来之后：`npm run tunnel:named`

### 临时测（每次重启换域名）

```bash
npm run tunnel
```

日志里的 `https://xxxx.trycloudflare.com/api/feishu/events` 可先填进飞书做挑战，测完改成固定域名。

1. 飞书开放平台建企业自建应用，开通收发消息权限，订阅事件 `im.message.receive_v1`
2. 把 `FEISHU_APP_ID`、`FEISHU_APP_SECRET`、`FEISHU_VERIFICATION_TOKEN`、`FEISHU_ENCRYPT_KEY` 写入 `server/.env`，重启后端
3. 网页登录 → 侧栏「绑定外部 agent」下载 Skill，交给飞书智能体。自建应用号不直接问答。

群里默认只在 @机器人 时回复提示。

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
