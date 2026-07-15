#!/bin/zsh
# rockstock-notify.sh — 統一 ntfy 推播小工具，給各 launchd 腳本「失敗吵手機」用。
# 用法: rockstock-notify.sh "<標題>" "<內文>" [優先級 default|high|urgent]
# topic 從 repo 的 .env.local 讀 NTFY_TOPIC_URL（不硬編）。無 topic 就安靜跳過。
set -u
TITLE="${1:-rockstock}"
BODY="${2:-}"
PRIO="${3:-high}"
ENVF="/Users/tc/Desktop/rockstock/.env.local"
URL=$(grep -E '^NTFY_TOPIC_URL=' "$ENVF" 2>/dev/null | head -1 | cut -d= -f2- | tr -d '"'"'"' ')
[[ -z "$URL" ]] && exit 0
curl -fsS --max-time 15 \
  -H "Title: $TITLE" \
  -H "Priority: $PRIO" \
  -H "Tags: warning" \
  -d "$BODY" \
  "$URL" >/dev/null 2>&1 || true
