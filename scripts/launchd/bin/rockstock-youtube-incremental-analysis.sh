#!/bin/zsh
# 白天 YouTube 增量分析：若逐字稿數比現有 analysis 多，才重算當日分析。
set -u
export TZ="Asia/Taipei"
D=$(date +%F)
echo "=== [$(date '+%H:%M:%S')] youtube incremental analysis 檢查, date=$D ==="

COVERAGE="$(cd "$(dirname "$0")" && pwd)/rockstock-youtube-analysis-coverage.sh"
# 直接讀最新 transcript-index，避免 prepare payload 尚未更新導致漏跑。
if "$COVERAGE" "$D"; then
  echo "[$(date '+%H:%M:%S')] 已涵蓋所有可用逐字稿，跳過"
  exit 0
fi

echo "[$(date '+%H:%M:%S')] 分析缺漏或無法驗證，重新準備逐字稿並補跑"
exec /Users/tc/.local/bin/rockstock-analysis-catchup.sh "$D"
