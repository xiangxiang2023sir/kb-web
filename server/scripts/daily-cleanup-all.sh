#!/usr/bin/env bash
# 所有工作脑的日结清理：默认保留 30 天，删掉的日结页 + 文件一起清
# 用法：daily-cleanup-all.sh [天数] [--apply]
set -uo pipefail
DAYS="${1:-30}"
APPLY="${2:-}"
cd "$(dirname "$0")/.." || exit 1
for src in $(/home/ujixx033/.local/bin/gbrain sources list 2>/dev/null | awk '$1 ~ /-work$/ && $1 !~ /\//{print $1}'); do
  echo "== $src =="
  ./node_modules/.bin/tsx scripts/daily-cleanup.ts --source "$src" --days "$DAYS" --files $APPLY
done
