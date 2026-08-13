#!/bin/zsh
# Dependency-aware EOD strategy pipeline. Deployed to ~/.local/bin by sync-bin.sh.
set -u

market="${1:-}"
if [[ "$market" != "TW" && "$market" != "CN" ]]; then
  echo "usage: rockstock-strategy-eod.sh TW|CN" >&2
  exit 2
fi

secret_file="$HOME/.config/rockstock/cron-secret"
if [[ ! -s "$secret_file" ]]; then
  echo "missing cron secret: $secret_file" >&2
  exit 1
fi
cron_secret="$(<"$secret_file")"
base_url="http://localhost:3000"
lock_dir="/tmp/rockstock-strategy-eod-${market}.lock"
if ! mkdir "$lock_dir" 2>/dev/null; then
  echo "${market} strategy EOD already running; skip duplicate trigger"
  exit 0
fi
trap 'rmdir "$lock_dir" 2>/dev/null || true' EXIT INT TERM

run_endpoint() {
  label="$1"
  endpoint="$2"
  echo "[$(date -Iseconds)] ${market} ${label} start"
  /usr/bin/curl -fsS --retry 2 --retry-delay 15 --retry-all-errors \
    --max-time 900 -H "Authorization: Bearer ${cron_secret}" "${base_url}${endpoint}"
  curl_status=$?
  echo
  if [[ "$curl_status" -ne 0 ]]; then
    echo "[$(date -Iseconds)] ${market} ${label} failed status=${curl_status}" >&2
    return "$curl_status"
  fi
  echo "[$(date -Iseconds)] ${market} ${label} done"
}

run_required_endpoint() {
  label="$1"
  endpoint="$2"
  # CN 的全市場補檔在 20:00 啟動，實測可能需 2–4 小時；A 的 coverage guard
  # 是真正的資料完成條件。讓策略低成本等待完整 verify report，而不是固定 25 分鐘
  # 後失敗，或在 catch-up 尚未完成時產出半套結果。TW 正常流程維持 25 分鐘上限。
  if [[ "$market" == "CN" ]]; then
    max_attempts=48
  else
    max_attempts=5
  fi
  attempt=1
  while [[ "$attempt" -le "$max_attempts" ]]; do
    if run_endpoint "$label" "$endpoint"; then
      return 0
    fi
    if [[ "$attempt" -lt "$max_attempts" ]]; then
      echo "[$(date -Iseconds)] ${market} ${label} not ready; waiting for complete L1 verify, retry $((attempt + 1))/${max_attempts} in 300s" >&2
      /bin/sleep 300
    fi
    attempt=$((attempt + 1))
  done
  return 1
}

# Fail closed: downstream strategies do not run until A has produced the Step 1 pool.
run_required_endpoint "A" "/api/cron/scan-${(L)market}" || exit $?
failures=0
for track in bullish reversal system mechanical; do
  run_endpoint "BM-${track}" "/api/cron/scan-bm-batch?market=${market}&track=${track}" || failures=$((failures + 1))
done

run_endpoint "SanSe" "/api/cron/scan-${(L)market}-sanse" || failures=$((failures + 1))

# 每次盤後成功後重算最近 10 個交易日，會自動補回休眠／上游故障期間漏掉的日期；
# 再由每日快照重建具名策略（底反、紅黃觸發等）日檔與統計。
# 這兩類產物過去沒有掛在任何每日 pipeline 上，才會出現 scan 已更新但底反只停在 08/10。
repo_root="$HOME/Desktop/rockstock"
tsx_cli="$HOME/.local/node-22/lib/node_modules/tsx/dist/cli.mjs"
if [[ "$market" == "TW" ]]; then
  sanse_backfill="scripts/backfill-tw-sanse-scan.ts"
else
  sanse_backfill="scripts/backfill-cn-sanse-scan.ts"
fi
echo "[$(date -Iseconds)] ${market} SanSe history catch-up start"
if (
  cd "$repo_root" &&
  "$HOME/.local/node-22/bin/node" "$tsx_cli" "$sanse_backfill" 10 &&
  "$HOME/.local/node-22/bin/node" "$tsx_cli" scripts/scan-strategy-history.ts "$market"
); then
  echo "[$(date -Iseconds)] ${market} SanSe history catch-up done"
else
  echo "[$(date -Iseconds)] ${market} SanSe history catch-up failed" >&2
  failures=$((failures + 1))
fi

run_endpoint "V" "/api/cron/scan-fundamental-revaluation?market=${market}" || failures=$((failures + 1))
if [[ "$market" == "TW" ]]; then
  run_endpoint "Y" "/api/cron/scan-inststeal-track" || failures=$((failures + 1))
fi
run_endpoint "health" "/api/cron/daily-health-snapshot?market=${market}" || failures=$((failures + 1))

if [[ "$failures" -ne 0 ]]; then
  echo "[$(date -Iseconds)] ${market} strategy EOD pipeline completed with ${failures} failure(s)" >&2
  exit 1
fi

echo "[$(date -Iseconds)] ${market} strategy EOD pipeline complete"
