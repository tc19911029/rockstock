#!/bin/zsh
# 白天 YouTube 增量分析：若逐字稿數比現有 analysis 多，才重算當日分析。
set -u
export TZ="Asia/Taipei"
D=$(date +%F)
echo "=== [$(date '+%H:%M:%S')] youtube incremental analysis 檢查, date=$D ==="

QUESTION_FILE="$TMPDIR/rockstock-youtube/$D-question.json"
ANALYSIS_FILE="/Users/tc/Desktop/rockstock/data/youtube/analysis/$D.json"
CURRENT_COUNT=$(python3 -c 'import json,sys; print(len(json.load(open(sys.argv[1])).get("videos", [])))' "$QUESTION_FILE" 2>/dev/null || echo "")
PREVIOUS_COUNT=$(node -e '
  const fs=require("fs");
  try {
    const j=JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    const n=j?.stats?.videos_analyzed;
    process.stdout.write(Number.isFinite(n) ? String(n) : "");
  } catch (_) {}
' "$ANALYSIS_FILE" 2>/dev/null)

if [[ -n "$CURRENT_COUNT" && "$CURRENT_COUNT" -eq 0 ]]; then
  echo "[$(date '+%H:%M:%S')] 尚無可分析逐字稿，跳過"
  exit 0
fi
if [[ -n "$CURRENT_COUNT" && -n "$PREVIOUS_COUNT" && "$PREVIOUS_COUNT" -ge "$CURRENT_COUNT" ]]; then
  echo "[$(date '+%H:%M:%S')] 無新增逐字稿（目前 $CURRENT_COUNT 支，上一版 $PREVIOUS_COUNT 支），跳過"
  exit 0
fi

echo "[$(date '+%H:%M:%S')] 偵測到新增逐字稿（${PREVIOUS_COUNT:-0} → ${CURRENT_COUNT:-未知} 支），更新分析"
exec /Users/tc/.local/bin/rockstock-analysis-catchup.sh "$D"
