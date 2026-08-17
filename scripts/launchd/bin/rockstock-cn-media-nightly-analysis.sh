#!/bin/zsh
# 每個陸股交易日的隔日 03:10（週二至週六）處理前一天第一財經節目。
# 排在台股 YouTube 最後一輪逐字稿之後，避免兩套 Whisper 同時搶 CPU／記憶體。
set -u
export PATH="/Users/tc/.local/node-22/bin:/Users/tc/.local/bin:/usr/local/bin:/usr/bin:/bin"
export TZ="Asia/Shanghai"

REPO="/Users/tc/Desktop/rockstock"
BASE="http://localhost:3000/api/cron"
D=$(date -v-1d +%F)
SECRET_FILE="${ROCKSTOCK_CRON_SECRET_FILE:-$HOME/.config/rockstock/cron-secret}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
CODEX_HELPER="$SCRIPT_DIR/rockstock-codex-cli.sh"
if [[ ! -r "$CODEX_HELPER" ]]; then
  echo "缺少 Codex 共用檢查器：$CODEX_HELPER" >&2
  exit 1
fi
source "$CODEX_HELPER"
QUESTION_DIR="$TMPDIR/rockstock-cn-media"
QUESTION_FILE="$QUESTION_DIR/$D-question.json"
ANALYSIS_FILE="$REPO/data/cn-media/analysis/$D.json"
ts() { date '+%H:%M:%S'; }

if [[ ! -r "$SECRET_FILE" ]]; then
  echo "[$(ts)] 缺少可讀密鑰檔：$SECRET_FILE" >&2
  exit 1
fi
CRON_SECRET_VALUE="$(tr -d '\r\n' < "$SECRET_FILE")"
if (( ${#CRON_SECRET_VALUE} < 32 )); then
  echo "[$(ts)] 密鑰檔無效（長度不足）" >&2
  exit 1
fi
AUTH="Authorization: Bearer $CRON_SECRET_VALUE"
unset CRON_SECRET_VALUE

echo "=== [$(ts)] 陸股節目分析開始，date=$D ==="

# 極端情況下台股 Whisper 可能仍在跑；最多等待 30 分鐘再退出，避免兩套模型互搶。
for (( wait_round=1; wait_round<=60; wait_round++ )); do
  transcript_pid=$(launchctl list 2>/dev/null | awk '$3 == "com.rockstock.youtube-transcript" {print $1}')
  [[ -z "$transcript_pid" || "$transcript_pid" == "-" ]] && break
  (( wait_round == 1 )) && echo "[$(ts)] 台股逐字稿仍在執行，等待收尾"
  sleep 30
done
transcript_pid=$(launchctl list 2>/dev/null | awk '$3 == "com.rockstock.youtube-transcript" {print $1}')
if [[ -n "$transcript_pid" && "$transcript_pid" != "-" ]]; then
  echo "[$(ts)] 台股逐字稿等待 30 分鐘仍未結束，本次略過" >&2
  exit 1
fi

curl -fsS --max-time 120 -H "$AUTH" -X POST "$BASE/cn-media-scan?date=$D" >/dev/null \
  && echo "[$(ts)] scan OK" \
  || { echo "[$(ts)] scan 失敗" >&2; exit 1; }

# 官方長節目與 B站短節目依序轉錄，避免多個 Whisper 模型同時造成記憶體尖峰。
curl -fsS --max-time 10800 -H "$AUTH" -X POST "$BASE/cn-media-transcript?date=$D" >/dev/null \
  && echo "[$(ts)] transcript OK" \
  || { echo "[$(ts)] transcript 失敗" >&2; exit 1; }

curl -fsS --max-time 600 -H "$AUTH" -X POST "$BASE/cn-media-prepare-analysis?date=$D" >/dev/null \
  && echo "[$(ts)] prepare OK" \
  || { echo "[$(ts)] prepare 失敗" >&2; exit 1; }

VCOUNT=""
for attempt in 1 2 3 4 5; do
  VCOUNT=$(python3 -c "import json,sys; print(len(json.load(open(sys.argv[1])).get('videos',[])))" "$QUESTION_FILE" 2>/dev/null || echo "")
  [[ -n "$VCOUNT" ]] && break
  sleep 2
done
if [[ -z "$VCOUNT" ]]; then
  echo "[$(ts)] question.json 無法讀取" >&2
  exit 1
elif [[ "$VCOUNT" -eq 0 ]]; then
  echo "=== [$(ts)] $D 沒有合格逐字稿，乾淨結束 ==="
  exit 0
fi

cd "$REPO" || exit 1
if ! rockstock_codex_preflight; then
  failure_kind="${ROCKSTOCK_CODEX_ERROR_KIND:-CLI_NOT_FOUND}"
  failure_hint="$(rockstock_codex_error_hint "$failure_kind")"
  echo "[$(ts)] Codex 預檢失敗 [$failure_kind]：$failure_hint" >&2
  exit 1
fi
echo "[$(ts)] Codex 預檢通過：${CODEX_BIN}（${ROCKSTOCK_CODEX_LOGIN_STATUS}）"

analysis_ok() {
  local start_epoch=$1 mtime size
  [[ -f "$ANALYSIS_FILE" ]] || return 1
  mtime=$(stat -f %m "$ANALYSIS_FILE" 2>/dev/null) || return 1
  size=$(stat -f %z "$ANALYSIS_FILE" 2>/dev/null) || return 1
  [[ "$mtime" -ge "$start_epoch" && "$size" -gt 1024 ]]
}

success=0
for (( attempt=1; attempt<=3; attempt++ )); do
  (( attempt == 2 )) && sleep 30
  (( attempt == 3 )) && sleep 120
  attempt_start=$(date +%s)
  attempt_log="$(mktemp "${TMPDIR:-/tmp}/rockstock-cn-media-codex.XXXXXX")"
  echo "[$(ts)] Codex 分析嘗試 $attempt/3（$VCOUNT 集）"
  "$CODEX_BIN" exec --ephemeral --sandbox workspace-write \
    --add-dir "$QUESTION_DIR" -C "$REPO" \
    "使用 cn-media-analysis skill 分析 $D 的陸股節目 question payload，完整執行技能的正規化與稽核，並寫入指定 output_path。" \
    >"$attempt_log" 2>&1
  rc=$?
  tail -40 "$attempt_log"
  if analysis_ok "$attempt_start"; then
    unlink "$attempt_log" 2>/dev/null || true
    success=1
    break
  fi
  failure_kind="$(rockstock_codex_classify_failure "$attempt_log" "$rc")"
  failure_hint="$(rockstock_codex_error_hint "$failure_kind")"
  unlink "$attempt_log" 2>/dev/null || true
  echo "[$(ts)] Codex 未產出 [$failure_kind, exit=$rc]：$failure_hint" >&2
  rockstock_codex_retryable "$failure_kind" || break
done

if (( success == 0 )); then
  echo "[$(ts)] Codex 連續三次未產出有效 analysis" >&2
  [[ -x /Users/tc/.local/bin/rockstock-notify.sh ]] && \
    /Users/tc/.local/bin/rockstock-notify.sh "陸股節目分析失敗 $D" "${failure_hint:-Codex 未產出有效結果}；$VCOUNT 集逐字稿待分析。" high
  exit 1
fi

npx tsx scripts/normalize-cn-media-analysis.ts "$D" || exit 1
npx tsx scripts/audit-cn-media-analysis.ts "$D" || exit 1
echo "=== [$(ts)] 陸股節目分析完成，date=$D ==="
