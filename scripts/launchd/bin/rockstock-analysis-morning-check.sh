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

# 完好 = 檔案存在 + 是合法 JSON + 有 stats 欄位。
# 不可用檔案大小判斷：週末休播的 analysis 只有 ~700 bytes 但完全正常，
# 用 size>1024 會被誤判成缺檔而無限重跑並發 urgent 通知。
is_ok() {
  [[ -f "$1" ]] || return 1
  node -e '
    const fs=require("fs");
    try{const j=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));
      process.exit(j && j.stats ? 0 : 1);
    }catch(e){process.exit(1)}
  ' "$1" 2>/dev/null
}

missing=()
for i in $(seq 1 "$LOOKBACK"); do
  D=$(date -v-${i}d +%F)
  if is_ok "$DIR/$D.json"; then
    echo "[$(date '+%H:%M:%S')] $D analysis 已存在 ✔"
  else
    echo "[$(date '+%H:%M:%S')] $D analysis 缺檔 → 排入補跑"
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
