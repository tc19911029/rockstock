#!/bin/zsh
# 每晚 22:15 CST 自動跑 /cn-agents-analysis（headless claude），讓陸股政策/題材語意層全自動。
#
# ⚠️ 此檔的「運行副本」放在 ~/.local/bin/rockstock-cn-agents-nightly-analysis.sh（非 iCloud 路徑）。
#    Desktop 這份是參考/版控用 — 改邏輯改這份後要 cp 過去（見檔尾安裝指令）。
#    原因同 youtube：~/Desktop 會被 iCloud evict 成 dataless，launchd 背景代理 fault-in 不了。
#
# 流程：prepare（抓新聞+組 question）→ headless claude 分析（寫 analysis/$D.json）→ compose（合成 daily）。
# 時序：eod 15:10 → lhb 19:30 → seats 20:10 → 【本腳本 22:15】→ compose plist 22:45 當 backstop。
# 認證：claude 走 Keychain「Claude Code-credentials」(訂閱)；plist 須給 HOME/USER/LOGNAME，
#       絕不可設 ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN（會改走 API 付費）。
set -u
export PATH="/Users/tc/.local/node-22/bin:/Users/tc/.local/bin:/usr/local/bin:/usr/bin:/bin"
export TZ="Asia/Taipei"

D=$(date +%F)
BASE="http://localhost:3000/api/cron"
AUTH="Authorization: Bearer CRON_SECRET"
ANALYSIS_FILE="/Users/tc/Desktop/rockstock/data/cn-agents/analysis/$D.json"
CLAUDE_BIN="/Users/tc/.local/node-22/bin/claude"
MAX_TRIES=3
ts() { date '+%H:%M:%S'; }
echo "=== [$(ts)] cn-agents nightly analysis 開始, date=$D ==="

# 1) prepare（抓今日新聞 digest + 組 question.json）。失敗不致命（compose 走 degraded）。
curl -fsS --max-time 150 -H "$AUTH" "$BASE/cn-agents-prepare?date=$D" >/dev/null 2>&1 \
  && echo "[$(ts)] prepare OK" || echo "[$(ts)] prepare 失敗（略過，繼續）"

# 2) headless claude 分析（讀 question → 寫 analysis/$D.json + reports/$D.md）。
#    重試（youtube 教訓）：headless claude 偶遇暫時性 API 斷線即死、且即使 Error 也可能 exit 0
#    → 不能只看 $?。成功判準 = analysis 檔在本次嘗試起點後才寫出且 size > 1KB。
#    絕不可設 ANTHROPIC_API_KEY（會改走 API 付費）。
echo "=== [$(ts)] 開始 claude 分析 ==="
cd /Users/tc/Desktop/rockstock || exit 1

analysis_ok() {
  local start_epoch=$1 mtime size
  [[ -f "$ANALYSIS_FILE" ]] || return 1
  mtime=$(stat -f %m "$ANALYSIS_FILE" 2>/dev/null) || return 1
  size=$(stat -f %z "$ANALYSIS_FILE" 2>/dev/null) || return 1
  [[ "$mtime" -ge "$start_epoch" && "$size" -gt 1024 ]]
}

success=0
for try in $(seq 1 $MAX_TRIES); do
  start_epoch=$(date +%s)
  echo "[$(ts)] claude 分析嘗試 $try/$MAX_TRIES"
  "$CLAUDE_BIN" --dangerously-skip-permissions -p "/cn-agents-analysis" >/tmp/rockstock-cn-agents-analysis-run.log 2>&1 || true
  if analysis_ok "$start_epoch"; then
    echo "[$(ts)] 分析成功（analysis/$D.json 已更新）"
    success=1
    break
  fi
  echo "[$(ts)] 嘗試 $try 未產出有效 analysis，稍候重試"
  sleep 10
done
[[ "$success" -eq 1 ]] || echo "[$(ts)] ⚠️ 分析 $MAX_TRIES 次都失敗 — compose 仍會走 degraded 重加權產出 daily"

# 3) compose（合程式分 + skill 語意分 → daily/$D.json + master_decision 事件）。冪等。
curl -fsS --max-time 150 -H "$AUTH" "$BASE/cn-agents-compose?date=$D" >/dev/null 2>&1 \
  && echo "[$(ts)] compose OK" || echo "[$(ts)] compose 失敗"

echo "=== [$(ts)] cn-agents nightly analysis 結束 ==="

# ── 安裝（改完這份後執行）──
#   cp scripts/cn-agents-nightly-analysis.sh ~/.local/bin/rockstock-cn-agents-nightly-analysis.sh
#   chmod +x ~/.local/bin/rockstock-cn-agents-nightly-analysis.sh
