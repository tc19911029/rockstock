#!/bin/zsh
# Dev server 模式切換 — launchd (cron 優先) vs manual (UI 優先)
#
# 為什麼存在：
#   - launchd 管 dev server 能 7x24 跑 cron，但 macOS launchd sandbox 限制下
#     Turbopack PostCSS pool worker spawn 失敗 → page 顯示 500（API endpoint
#     仍 200，所以 14 個 launchd cron 還是會 work）。
#   - 要看 UI 必須把 launchd dev server 停掉、改用 manual npm run dev（或 Claude
#     Preview）跑，這樣 Turbopack PostCSS 在 GUI session env 內 spawn 才成功。
#
# 用法：
#   bash scripts/launchd/dev-server-mode.sh status   — 看目前模式
#   bash scripts/launchd/dev-server-mode.sh ui       — 切到 UI 模式（停 launchd，手動 npm run dev）
#   bash scripts/launchd/dev-server-mode.sh cron     — 切回 cron 模式（重新 bootstrap launchd）

set -e

MODE="${1:-status}"
UID_NUM=$(id -u)
LABEL="com.rockstock.dev-server"
PLIST="$HOME/Library/LaunchAgents/${LABEL}.plist"

case "$MODE" in
  status)
    if launchctl print "gui/${UID_NUM}/${LABEL}" >/dev/null 2>&1; then
      echo "目前模式：cron (launchd 管 dev server)"
      echo "  PID: $(launchctl list | awk -v l="$LABEL" '$3==l {print $1}')"
      echo "  log: /tmp/rockstock-dev-server.log"
      echo "  限制：rockstock 網頁打不開 (page 500)；API endpoint 200 cron 仍正常"
    else
      echo "目前模式：UI (launchd 未跑，需手動 npm run dev)"
      pid=$(lsof -ti:3000 -sTCP:LISTEN 2>/dev/null | head -1)
      if [ -n "$pid" ]; then
        echo "  port 3000 PID: $pid (手動 / Claude Preview 跑的)"
      else
        echo "  ❌ port 3000 沒人聽 — launchd cron 會全 401"
      fi
    fi
    ;;

  ui)
    echo "==> 停 launchd dev server..."
    launchctl bootout "gui/${UID_NUM}/${LABEL}" 2>/dev/null || echo "  (本來就沒跑)"
    sleep 2
    if [ -n "$(lsof -ti:3000 -sTCP:LISTEN 2>/dev/null)" ]; then
      echo "  ⚠️  port 3000 還在被 occupy，可能 Preview 已自啟"
    else
      echo "  ✅ port 3000 已空"
    fi
    echo ""
    echo "現在請：開另一個 Terminal，cd ~/Desktop/rockstock，npm run dev"
    echo "（或 Claude Code 內的 Preview 會自動跑 dev）"
    echo "看完 UI 後回來跑：bash $0 cron"
    ;;

  cron)
    echo "==> 停手動跑的 dev server (如有)..."
    pid=$(lsof -ti:3000 -sTCP:LISTEN 2>/dev/null | head -1)
    if [ -n "$pid" ]; then
      kill "$pid" 2>/dev/null || true
      sleep 2
    fi
    echo ""
    echo "==> bootstrap launchd dev server..."
    if [ ! -f "$PLIST" ]; then
      cp "$(dirname "$0")/plists/${LABEL}.plist" "$PLIST"
      xattr -c "$PLIST" 2>/dev/null
    fi
    launchctl bootstrap "gui/${UID_NUM}" "$PLIST"
    echo ""
    echo "==> 等 Ready..."
    for i in $(seq 1 30); do
      if grep -q "Ready in" /tmp/rockstock-dev-server.log 2>/dev/null; then
        echo "  ✅ Ready after ${i}s — launchd 在跑了"
        break
      fi
      sleep 1
    done
    echo ""
    echo "Cron 模式已啟動。要看 UI 時跑：bash $0 ui"
    ;;

  *)
    echo "用法：bash $0 [status|ui|cron]"
    exit 1
    ;;
esac
