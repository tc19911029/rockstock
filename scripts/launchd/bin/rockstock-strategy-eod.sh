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
  status=$?
  echo
  if [[ "$status" -ne 0 ]]; then
    echo "[$(date -Iseconds)] ${market} ${label} failed status=${status}" >&2
    return "$status"
  fi
  echo "[$(date -Iseconds)] ${market} ${label} done"
}

# Fail closed: downstream strategies do not run until A has produced the Step 1 pool.
run_endpoint "A" "/api/cron/scan-${(L)market}" || exit $?
failures=0
for track in bullish reversal system mechanical; do
  run_endpoint "BM-${track}" "/api/cron/scan-bm-batch?market=${market}&track=${track}" || failures=$((failures + 1))
done

run_endpoint "SanSe" "/api/cron/scan-${(L)market}-sanse" || failures=$((failures + 1))
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
