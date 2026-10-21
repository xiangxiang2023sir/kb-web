#!/usr/bin/env bash
# kb-web 一键还原（换机器后跑这个）
# 前提：node/bun/gbrain 已装；~/.gbrain、~/kb-sources、~/kb-web、server/.env 已拷到本机
set -euo pipefail
HOME_DIR="${HOME:-/home/ujixx033}"
REPO="$HOME_DIR/kb-web"
UNIT_DIR="$HOME_DIR/.config/systemd/user"
mkdir -p "$UNIT_DIR"

echo "== 1/5 检查依赖 =="
for c in node bun gbrain; do
  command -v "$c" >/dev/null 2>&1 && echo "  ✓ $c" || { echo "  ✗ 缺 $c，请先安装"; exit 1; }
done

echo "== 2/5 安装 kb-web 依赖并构建 =="
cd "$REPO"
npm install --prefix server >/dev/null 2>&1 || npm install
npm run build

echo "== 3/5 注册 gbrain-serve 服务 =="
KEY_FILE="$HOME_DIR/agents/小A/工具/.siliconflow_key"
KEY=""
[ -r "$KEY_FILE" ] && KEY="$(cat "$KEY_FILE")"
cat > "$UNIT_DIR/gbrain-serve.service" <<EOF
[Unit]
Description=GBrain HTTP service (kb-web 知识库引擎)
After=network.target
[Service]
Type=simple
Environment=HOME=$HOME_DIR
Environment=PATH=$HOME_DIR/.local/bin:$HOME_DIR/.hermes/node/bin:/usr/local/bin:/usr/bin:/bin
Environment=OPENAI_API_KEY=$KEY
Environment=OPENAI_BASE_URL=https://api.siliconflow.cn/v1
ExecStart=$HOME_DIR/.local/bin/gbrain serve --http --port 3131
Restart=always
[Install]
WantedBy=default.target
EOF

echo "== 4/5 注册 kb-web 服务 =="
cat > "$UNIT_DIR/kb-web.service" <<EOF
[Unit]
Description=kb-web (工厂知识库网站)
After=network.target gbrain-serve.service
[Service]
Type=simple
WorkingDirectory=$REPO
Environment=HOME=$HOME_DIR
Environment=PATH=$HOME_DIR/.hermes/node/bin:/usr/local/bin:/usr/bin:/bin
ExecStart=/bin/bash -lc 'cd $REPO && npm start'
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
echo "完成。公网入口（cloudflared）需单独配置：/etc/cloudflared/token"
