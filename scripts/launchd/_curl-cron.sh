#!/bin/zsh
# 共用 cron 觸發腳本
# 用法：./_curl-cron.sh <label> <endpoint> [endpoint2 ...]
# 範例：./_curl-cron.sh tw-scan "/api/cron/scan-tw"
#       ./_curl-cron.sh cn-flow "/api/cron/fetch-cn-capital-flow" "/api/cron/fetch-cn-flow"
#
# ⚠️ 警告（2026-05-19）：當本檔位於 ~/Desktop 下時，macOS launchd 沙箱會擋住此腳本執行
#    （exit 127、stderr 顯示 "can't open input file"）。所有 plist 已改用 inline /usr/bin/curl
#    繞開，不再依賴本檔。新增 plist 請鏡像 `com.rockstock.cn-daban-close.plist` 的 inline 寫法，
#    不要走 _curl-cron.sh 路徑，除非本檔被搬離 ~/Desktop 或 /bin/zsh 取得完全取用磁碟權限。

set -e

LABEL="${1:-unknown}"
shift

if [ $# -eq 0 ]; then
  echo "[$(date '+%F %T')] [$LABEL] no endpoints provided"
  exit 1
fi

# CRON_SECRET 由 launchd EnvironmentVariables 注入；本機 dev 不檢查也沒關係
SECRET="${CRON_SECRET:-CRON_SECRET}"

for endpoint in "$@"; do
  echo "[$(date '+%F %T')] [$LABEL] GET $endpoint"
  /usr/bin/curl -fsS \
    --max-time 600 \
    -H "Authorization: Bearer $SECRET" \
    -w "\n[$LABEL] HTTP %{http_code} time=%{time_total}s\n" \
    "http://localhost:3000${endpoint}" \
    || echo "[$(date '+%F %T')] [$LABEL] curl failed (exit $?) for $endpoint"
done
