#!/bin/zsh
# rockstock-analysis-morning-check.sh — 早上守門：近幾天的 YouTube 分析缺檔就自動補跑
# 背景：2026-06-13 凌晨 claude OAuth 403 暫時失效 ~100 分鐘，nightly 3 次重試全落在窗內 →
#       2026-06-12 整天沒 analysis。重試窗拉長到隔天早上可自癒這類過夜性故障。
# 2026-07-15：只檢查「昨天」不夠 — OAuth token 過期是持續數天的故障（07-13 過期，
#       07-13/14/15 三天全缺，但守門每天只看昨天，07-13 從頭到尾沒被補過）。改掃近 LOOKBACK 天。
set -u
export TZ="Asia/Taipei"
export PATH="/Users/tc/.local/node-22/bin:/Users/tc/.local/bin:/usr/local/bin:/usr/bin:/bin"

LOOKBACK=${LOOKBACK:-4}   # 檢查昨天起往回幾天
DIR="/Users/tc/Desktop/rockstock/data/youtube/analysis"

# 核對索引中已取得逐字稿的影片 ID；昨天新增字幕也必須補分析。
COVERAGE="$(cd "$(dirname "$0")" && pwd)/rockstock-youtube-analysis-coverage.sh"
is_ok() {
  "$COVERAGE" "$1"
}

missing=()
for i in $(seq 1 "$LOOKBACK"); do
  D=$(date -v-${i}d +%F)
  if is_ok "$D"; then
    echo "[$(date '+%H:%M:%S')] $D analysis 涵蓋可用逐字稿 ✔"
  else
    echo "[$(date '+%H:%M:%S')] $D analysis 缺漏或無法驗證 → 排入補跑"
    missing+=("$D")
  fi
done

if (( ${#missing[@]} == 0 )); then
  echo "[$(date '+%H:%M:%S')] 近 $LOOKBACK 天分析齊全，無需補跑"
  exit 0
fi

# 由舊到新補，時間軸順序比較好讀
sorted=(${(On)missing})
echo "[$(date '+%H:%M:%S')] 啟動補跑：${sorted[*]}"
exec /Users/tc/.local/bin/rockstock-analysis-catchup.sh "${sorted[@]}"
