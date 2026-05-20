#!/bin/zsh
# EOD settlement wrapper for launchd
#
# ⚠️ DEPRECATED（2026-05-19）：因 ~/Desktop launchd 沙箱問題，plist 已改成 inline 模式
#    （見 com.rockstock.eod-settle-{tw,cn}.plist）。本檔保留供手動執行，但 launchd 不再用。
# 用法：./_eod-settle.sh TW   或   ./_eod-settle.sh CN

set -e

MARKET="${1:-TW}"
if [ "$MARKET" != "TW" ] && [ "$MARKET" != "CN" ]; then
  echo "[$(date '+%F %T')] [eod-settle] invalid market: $MARKET"
  exit 1
fi

# 用 lastTradingDay — 但盤後跑時 today 應該也是交易日
DATE=$(/bin/date +%Y-%m-%d)
LOG="/tmp/rockstock-eod-settle-${MARKET}.log"

echo "[$(date '+%F %T')] [eod-settle-${MARKET}] start date=${DATE}" >> "$LOG"
cd /Users/tzu-chienhsu/Desktop/rockstock
/usr/local/bin/npx tsx scripts/eod-settle.ts --market "$MARKET" --date "$DATE" --apply --concurrency 10 >> "$LOG" 2>&1
echo "[$(date '+%F %T')] [eod-settle-${MARKET}] done exit=$?" >> "$LOG"
