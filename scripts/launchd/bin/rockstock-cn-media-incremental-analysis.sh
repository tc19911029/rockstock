#!/bin/zsh
# 陸股節目日內增量管線：掃描 → 只轉錄一支最新待處理節目 → 有新增才更新分析。
# 凌晨完整補漏仍由 rockstock-cn-media-nightly-analysis.sh 負責。
set -u
export PATH="/Users/tc/.local/node-22/bin:/Users/tc/.local/bin:/usr/local/bin:/usr/bin:/bin"
export TZ="Asia/Shanghai"

REPO="/Users/tc/Desktop/rockstock"
BASE="http://localhost:3000"
D="${ROCKSTOCK_CN_MEDIA_DATE:-$(date +%F)}"
SECRET_FILE="${ROCKSTOCK_CRON_SECRET_FILE:-$HOME/.config/rockstock/cron-secret}"
LOCK_DIR="/tmp/rockstock-cn-media-incremental.lock"
RUN_DIR="$(mktemp -d /tmp/rockstock-cn-media-incremental.XXXXXX)"
NODE_BIN="/Users/tc/.local/node-22/bin/node"
TSX_CLI="/Users/tc/.local/node-22/lib/node_modules/tsx/dist/cli.mjs"
ts() { date '+%H:%M:%S'; }

if [[ -z "${ROCKSTOCK_CN_MEDIA_DATE:-}" ]] && (( $(date +%u) > 5 )); then
  echo "[$(ts)] 非陸股交易日排程（週末），本輪跳過"
  rm -rf "$RUN_DIR"
  exit 0
fi

acquire_lock() {
  if mkdir "$LOCK_DIR" 2>/dev/null; then
    printf '%s\n' "$$" > "$LOCK_DIR/pid"
    return 0
  fi
  local previous_pid=""
  [[ -r "$LOCK_DIR/pid" ]] && previous_pid="$(<"$LOCK_DIR/pid")"
  if [[ "$previous_pid" =~ ^[0-9]+$ ]] && kill -0 "$previous_pid" 2>/dev/null; then
    return 1
  fi
  unlink "$LOCK_DIR/pid" 2>/dev/null || true
  rmdir "$LOCK_DIR" 2>/dev/null || return 1
  mkdir "$LOCK_DIR" 2>/dev/null || return 1
  printf '%s\n' "$$" > "$LOCK_DIR/pid"
  echo "[$(ts)] 已回收前次異常中止留下的 stale lock"
}
if ! acquire_lock; then
  echo "[$(ts)] 前一輪陸股增量管線仍在執行，本輪跳過"
  rm -rf "$RUN_DIR"
  exit 0
fi
cleanup() {
  unlink "$LOCK_DIR/pid" 2>/dev/null || true
  rmdir "$LOCK_DIR" 2>/dev/null || true
  rm -rf "$RUN_DIR"
}
trap cleanup EXIT INT TERM

if [[ ! "$D" =~ ^20[0-9]{2}-[0-9]{2}-[0-9]{2}$ ]]; then
  echo "[$(ts)] 日期格式錯誤：$D" >&2
  exit 2
fi
if [[ ! -r "$SECRET_FILE" ]]; then
  echo "[$(ts)] 缺少可讀密鑰檔：$SECRET_FILE" >&2
  exit 1
fi
CRON_SECRET_VALUE="$(tr -d '\r\n' < "$SECRET_FILE")"
if (( ${#CRON_SECRET_VALUE} < 32 )); then
  echo "[$(ts)] 密鑰檔無效（長度不足）" >&2
  exit 1
fi
AUTH_CONFIG="$RUN_DIR/curl-auth.conf"
umask 077
printf 'header = "Authorization: Bearer %s"\n' "$CRON_SECRET_VALUE" > "$AUTH_CONFIG"
unset CRON_SECRET_VALUE

CODEX_BIN="${ROCKSTOCK_CODEX_BIN:-}"
if [[ -z "$CODEX_BIN" ]]; then
  for candidate in \
    /Applications/ChatGPT.app/Contents/Resources/codex \
    /Applications/Codex.app/Contents/Resources/codex; do
    if [[ -x "$candidate" ]]; then
      CODEX_BIN="$candidate"
      break
    fi
  done
fi

echo "=== [$(ts)] 陸股節目增量檢查，date=$D ==="

SCAN_JSON="$RUN_DIR/scan.json"
curl -fsS --config "$AUTH_CONFIG" --max-time 240 -X POST \
  "$BASE/api/cron/cn-media-scan?date=$D" -o "$SCAN_JSON" \
  || { echo "[$(ts)] scan 失敗" >&2; exit 1; }
FOUND=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1])).get("videos_found",0))' "$SCAN_JSON" 2>/dev/null || echo 0)
echo "[$(ts)] scan 完成，目前 $FOUND 支"

STATE_JSON="$RUN_DIR/state.json"
curl -fsS --max-time 60 "$BASE/api/cn-media/videos?date=$D" -o "$STATE_JSON" \
  || { echo "[$(ts)] 讀取節目狀態失敗" >&2; exit 1; }

# 優先處理新節目；同狀態內取最新發布，失敗／低品質只在沒有 pending 時重試。
VIDEO_ID=$(python3 - "$STATE_JSON" <<'PY'
import json, sys
data = json.load(open(sys.argv[1]))
states = {item['video_id']: item.get('status', 'pending') for item in data.get('transcripts', [])}
priority = {'pending': 3, 'low_quality': 2, 'failed': 1}
candidates = [v for v in data.get('videos', []) if states.get(v.get('video_id'), 'pending') != 'available']
if candidates:
    chosen = max(candidates, key=lambda v: (
        priority.get(states.get(v.get('video_id'), 'pending'), 0),
        v.get('published_at', ''),
    ))
    print(chosen['video_id'])
PY
)

if [[ -n "$VIDEO_ID" ]]; then
  if [[ ! "$VIDEO_ID" =~ ^[A-Za-z0-9_-]+$ ]]; then
    echo "[$(ts)] 不安全的 video_id：$VIDEO_ID" >&2
    exit 1
  fi
  TRANSCRIPT_JSON="$RUN_DIR/transcript.json"
  echo "[$(ts)] 轉錄最新待處理節目 $VIDEO_ID"
  curl -fsS --config "$AUTH_CONFIG" --max-time 3600 -X POST \
    "$BASE/api/cron/cn-media-transcript?date=$D&video_id=$VIDEO_ID" -o "$TRANSCRIPT_JSON" \
    || { echo "[$(ts)] transcript 失敗：$VIDEO_ID" >&2; exit 1; }
  TRANSCRIPT_STATUS=$(python3 -c 'import json,sys; r=json.load(open(sys.argv[1])).get("results",[]); print(r[0].get("status","unknown") if r else "missing")' "$TRANSCRIPT_JSON" 2>/dev/null || echo unknown)
  echo "[$(ts)] transcript $VIDEO_ID → $TRANSCRIPT_STATUS"
else
  echo "[$(ts)] 沒有待處理節目"
fi

PREPARE_JSON="$RUN_DIR/prepare.json"
curl -fsS --config "$AUTH_CONFIG" --max-time 600 -X POST \
  "$BASE/api/cron/cn-media-prepare-analysis?date=$D" -o "$PREPARE_JSON" \
  || { echo "[$(ts)] prepare 失敗" >&2; exit 1; }
CURRENT_COUNT=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1])).get("videos_with_transcript",0))' "$PREPARE_JSON" 2>/dev/null || echo 0)
QUESTION_PATH=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1])).get("question_path",""))' "$PREPARE_JSON" 2>/dev/null || echo "")
QUESTION_DIR="${QUESTION_PATH:h}"
if [[ -z "$QUESTION_PATH" || ! -r "$QUESTION_PATH" ]]; then
  echo "[$(ts)] question payload 路徑無效：${QUESTION_PATH:-missing}" >&2
  exit 1
fi

ANALYSIS_JSON="$RUN_DIR/analysis-before.json"
curl -fsS --max-time 60 "$BASE/api/cn-media/analysis/$D" -o "$ANALYSIS_JSON" \
  || { echo "[$(ts)] 讀取既有分析失敗" >&2; exit 1; }
PREVIOUS_COUNT=$(python3 -c 'import json,sys; a=json.load(open(sys.argv[1])).get("analysis") or {}; print((a.get("stats") or {}).get("videos_analyzed",0))' "$ANALYSIS_JSON" 2>/dev/null || echo 0)

if (( CURRENT_COUNT == 0 )); then
  echo "[$(ts)] 尚無可用逐字稿，跳過分析"
  exit 0
fi
if (( PREVIOUS_COUNT >= CURRENT_COUNT )); then
  echo "[$(ts)] 無新增可用逐字稿（$CURRENT_COUNT 支），跳過分析"
  exit 0
fi
if [[ -z "$CODEX_BIN" || ! -x "$CODEX_BIN" ]]; then
  echo "[$(ts)] 找不到 Codex CLI（已檢查 ChatGPT.app 與 Codex.app）" >&2
  exit 1
fi

analysis_ok() {
  local check_json="$RUN_DIR/analysis-check.json"
  curl -fsS --max-time 60 "$BASE/api/cn-media/analysis/$D" -o "$check_json" || return 1
  "$NODE_BIN" -e '
    const fs = require("fs");
    const payload = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    const count = payload?.analysis?.stats?.videos_analyzed ?? 0;
    process.exit(count >= Number(process.argv[2]) ? 0 : 1);
  ' "$check_json" "$CURRENT_COUNT"
}

cd "$REPO" || exit 1
success=0
for attempt in 1 2; do
  (( attempt == 2 )) && sleep 60
  echo "[$(ts)] 新增逐字稿 $PREVIOUS_COUNT → $CURRENT_COUNT，Codex 分析嘗試 $attempt/2"
  "$CODEX_BIN" exec --ephemeral --sandbox workspace-write \
    --add-dir "$QUESTION_DIR" \
    -C "$REPO" \
    "使用 cn-media-analysis skill 分析 $D 的陸股節目 question payload，完整執行技能的正規化與稽核，並寫入指定 output_path。" \
    2>&1 | tail -5
  if analysis_ok; then
    success=1
    break
  fi
done

if (( success == 0 )); then
  echo "[$(ts)] Codex 未產出包含 $CURRENT_COUNT 支節目的有效分析" >&2
  [[ -x /Users/tc/.local/bin/rockstock-notify.sh ]] && \
    /Users/tc/.local/bin/rockstock-notify.sh \
      "陸股節目增量分析失敗 $D" "$CURRENT_COUNT 支逐字稿待分析" high
  exit 1
fi

"$NODE_BIN" "$TSX_CLI" scripts/normalize-cn-media-analysis.ts "$D" || exit 1
"$NODE_BIN" "$TSX_CLI" scripts/audit-cn-media-analysis.ts "$D" || exit 1
echo "=== [$(ts)] 陸股節目增量分析完成，$CURRENT_COUNT 支 ==="
