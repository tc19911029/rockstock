#!/bin/zsh
# rockstock-analysis-catchup.sh — 補跑認證失效/故障期間漏掉的分析日
# 用法: rockstock-analysis-catchup.sh 2026-06-12 2026-06-11 2026-06-10
# 與 keyframe-backfill 的差別：不抽幀（已抽好）、claude stderr 留在 log。
#
# 2026-07-15 三修（皆為與 nightly 的 parity 缺口）：
#   1. 成功判準原為 size>1024 → 週末休播的 analysis 只有 ~700B 但完全正常，
#      會被判失敗、重試 3 次、再發 urgent 通知。改為「合法 JSON + 有 stats + mtime 夠新」。
#   2. 補上 nightly step 3b 的「無可分析影片就乾淨跳過」，週末不叫 claude 硬撐。
#   3. 補上 nightly step 4.5 的 normalize（catchup 產出的 analysis 過去從未正規化）。
set -u
export PATH="/Users/tc/.local/node-22/bin:/Users/tc/.local/bin:/usr/local/bin:/usr/bin:/bin"
export TZ="Asia/Taipei"
BASE="http://localhost:3000/api/cron"
AUTH="Authorization: Bearer CRON_SECRET"
CLAUDE_BIN="/Users/tc/.local/node-22/bin/claude"
REPO="/Users/tc/Desktop/rockstock"
ts() { date '+%m-%d %H:%M:%S'; }

# 成功 = 檔案存在 + mtime >= 本次嘗試起點 + 合法 JSON 且有 stats。
# 不可用 size 判斷：休播日的合法 analysis 只有幾百 bytes。
analysis_ok() {
  local file=$1 start_epoch=$2 mtime
  [[ -f "$file" ]] || return 1
  mtime=$(stat -f %m "$file" 2>/dev/null) || return 1
  [[ "$mtime" -ge "$start_epoch" ]] || return 1
  node -e '
    const fs=require("fs");
    try{const j=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));
      process.exit(j && j.stats ? 0 : 1);
    }catch(e){process.exit(1)}
  ' "$file" 2>/dev/null
}

for D in "$@"; do
  echo "=== [$(ts)] ▶ catchup $D ==="
  curl -fsS --max-time 300 -H "$AUTH" -X POST "$BASE/youtube-prepare-analysis?date=$D&force=1" >/dev/null 2>&1 \
    && echo "[$(ts)] $D prepare OK" || { echo "[$(ts)] $D prepare 失敗，跳過"; continue; }

  # 無可分析影片就乾淨跳過（休播日）。讀 question.json 的 videos[]（只含 transcript available 的），
  # 不可數 iCloud 上的 transcripts/$D（會被 evict 成佔位檔 → 假性 0 支）。
  # 解析失敗 vs 真的 0 支要分開：解析失敗時仍嘗試分析，以免漏。
  QUESTION_FILE="$TMPDIR/rockstock-youtube/$D-question.json"
  VCOUNT=""
  for attempt in 1 2 3 4 5; do
    VCOUNT=$(python3 -c "import json,sys; print(len(json.load(open(sys.argv[1])).get('videos',[])))" "$QUESTION_FILE" 2>/dev/null || echo "")
    [[ -n "$VCOUNT" ]] && break
    echo "[$(ts)] $D question.json 尚未就緒(第 $attempt 次)，2s 後重讀"
    sleep 2
  done
  if [[ -z "$VCOUNT" ]]; then
    echo "[$(ts)] $D question.json 讀取失敗(非 0 支，是解析失敗)，仍嘗試分析以免漏"
  elif [[ "$VCOUNT" -eq 0 ]]; then
    echo "[$(ts)] $D 無可分析影片(question videos=0)，乾淨跳過、不叫 claude"
    continue
  else
    echo "[$(ts)] $D 有 $VCOUNT 支可分析影片，進入分析"
  fi

  ANALYSIS_FILE="$REPO/data/youtube/analysis/$D.json"
  cd "$REPO" || exit 1
  success=0
  for i in 1 2 3; do
    [[ $i -gt 1 ]] && sleep $(( i * 120 ))
    attempt_start=$(date +%s)
    echo "[$(ts)] $D claude 嘗試 $i/3"
    "$CLAUDE_BIN" -p "/youtube-analysis $D" --model opus --permission-mode bypassPermissions 2>&1 | tail -3
    if analysis_ok "$ANALYSIS_FILE" "$attempt_start"; then
      success=1
      echo "[$(ts)] $D ✅ 分析完成 (size=$(stat -f %z "$ANALYSIS_FILE"))"
      break
    fi
    echo "[$(ts)] $D ⚠️ 嘗試 $i 未產出"
  done
  if [[ $success -eq 0 ]]; then
    echo "[$(ts)] $D ❌ 仍失敗"
    /Users/tc/.local/bin/rockstock-notify.sh \
      "❌ YouTube 補跑失敗 $D" \
      "早上補救網也補不回 $D 的 analysis（常見主因:headless claude OAuth 過期或 403 地區封鎖，需 /login 或把 claude/anthropic 網域釘美國節點）。手動:對話跑 /youtube-analysis $D" \
      urgent
    continue
  fi

  # 確定性正規化（與 nightly step 4.5 同）：異體字/screenshot_ref 絕對路徑/自創 enum。
  npx tsx scripts/normalize-youtube-analysis.ts "$D" \
    && echo "[$(ts)] $D normalize OK" || echo "[$(ts)] $D ⚠️ normalize 回非零（需人工複查，不致命）"

  npx tsx scripts/audit-keyframe-coverage.ts "$D" >/dev/null 2>&1 \
    && echo "[$(ts)] $D coverage PASS" || echo "[$(ts)] $D ⚠️ coverage 有 FAIL（備查）"
  curl -fsS --max-time 300 -H "$AUTH" -X POST "$BASE/youtube-reco-events?date=$D" >/dev/null 2>&1 \
    && echo "[$(ts)] $D reco-events OK" || echo "[$(ts)] $D reco-events 失敗（15:30 cron 會補）"
  echo "=== [$(ts)] ✔ catchup $D 完成 ==="
done
echo "=== [$(ts)] catchup 全部結束 ==="
