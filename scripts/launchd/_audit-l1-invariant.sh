#!/bin/zsh
# 每日跑 L1 OHLC invariant audit，寫進 health snapshot 目錄
#
# ⚠️ DEPRECATED（2026-05-19）：因 ~/Desktop launchd 沙箱問題，plist 已改成 inline 模式
#    （見 com.rockstock.audit-l1-invariant.plist）。本檔保留供手動執行，但 launchd 不再用。
#    新增 plist 請鏡像現有 inline 寫法，不要再走 sh wrapper。
# 用法：./_audit-l1-invariant.sh

set -e

cd /Users/tzu-chienhsu/Desktop/rockstock
DATE=$(/bin/date +%Y-%m-%d)
LOG="/tmp/rockstock-audit-l1-invariant.log"

echo "[$(date '+%F %T')] [audit-l1-invariant] start" >> "$LOG"
/usr/local/bin/npx tsx scripts/audit-l1-invariant.ts --json --write "data/health-snapshot/l1-invariant-${DATE}.json" >> "$LOG" 2>&1
echo "[$(date '+%F %T')] [audit-l1-invariant] done exit=$?" >> "$LOG"
