#!/usr/bin/env bash
# kb-web 一键还原（换机器后跑这个）
# 前提：node/bun/gbrain 已装；~/.gbrain、~/kb-sources、~/kb-web、server/.env 已拷到本机
# 密钥只放 ~/kb-web/server/.env，不要写进 unit 文件。
set -euo pipefail
HOME_DIR="${HOME:?请设置 HOME}"
REPO="$HOME_DIR/kb-web"
ENV_FILE="$REPO/server/.env"
UNIT_DIR="$HOME_DIR/.config/systemd/user"
mkdir -p "$UNIT_DIR"

echo "== 1/5 检查依赖 =="
for c in node bun gbrain; do
  command -v "$c" >/dev/null 2>&1 && echo "  ✓ $c" || { echo "  ✗ 缺 $c，请先安装"; exit 1; }
done
[ -r "$ENV_FILE" ] && echo "  ✓ server/.env" || { echo "  ✗ 缺 $ENV_FILE，请先拷密钥"; exit 1; }

echo "== 2/5 安装 kb-web 依赖并构建 =="
cd "$REPO"
npm install --prefix server
npm run build

echo "== 3/5 注册 gbrain-serve 服务 =="
cat > "$UNIT_DIR/gbrain-serve.service" <<EOF
[Unit]
Description=GBrain HTTP service (admin / MCP，问答仍走 CLI spawn)
After=network.target
[Service]
Type=simple
WorkingDirectory=$HOME_DIR
Environment=HOME=$HOME_DIR
Environment=PATH=$HOME_DIR/.local/bin:$HOME_DIR/.hermes/node/bin:/usr/local/bin:/usr/bin:/bin
Environment=GBRAIN_QUERY_EMBED_TIMEOUT_MS=20000
EnvironmentFile=$ENV_FILE
ExecStart=$HOME_DIR/.local/bin/gbrain serve --http --port 3131 --bind 127.0.0.1
Restart=always
[Install]
WantedBy=default.target
EOF

echo "== 4/5 注册 kb-web 服务 =="
cat > "$UNIT_DIR/kb-web.service" <<EOF
[Unit]
Description=kb-web (工厂知识库网站)
After=network.target
[Service]
Type=simple
WorkingDirectory=$REPO
Environment=HOME=$HOME_DIR
Environment=PATH=$HOME_DIR/.local/bin:$HOME_DIR/.hermes/node/bin:/usr/local/bin:/usr/bin:/bin
Environment=GBRAIN_QUERY_EMBED_TIMEOUT_MS=20000
EnvironmentFile=$ENV_FILE
ExecStart=/usr/bin/env npm --prefix $REPO/server start
Restart=always
[Install]
WantedBy=default.target
EOF

echo "== 5/5 启动并自检 =="
systemctl --user daemon-reload
systemctl --user enable --now gbrain-serve.service kb-web.service
sleep 8
echo -n "  kb-web      : "; curl -s -o /dev/null -w '%{http_code}\n' --max-time 8 http://127.0.0.1:3000/ || true
echo -n "  gbrain-serve: "; curl -s -o /dev/null -w '%{http_code}\n' --max-time 8 http://127.0.0.1:3131/admin/ || true
echo "完成。公网入口（cloudflared）需单独配置。密钥在 $ENV_FILE，问答走 CLI spawn 不走 /mcp。"
