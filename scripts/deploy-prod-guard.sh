#!/bin/sh
# scripts/deploy-prod-guard.sh
#
# 安全重啟 :3000 production server（npm run start，由 launchd com.rockstock.prod-server 管），
# 讓 lib 原始碼改動（如 lib/datasource/CandleStorageAdapter.ts 的 dupPrevDayGuard）在
# server-path 寫入生效。改 lib 不 build+重啟，prod build 永遠跑舊碼。
#
# ⚠️ 為什麼要小心：instrumentation.ts 的「local-cron」就是這台機器的資料管線
#    （L2 刷新 / 盤中掃描 / 盤後 download-candles + append-from-snapshot + 掃描）。
#    重啟會把 downloadL1 的 in-memory 去重旗標清空 → boot 後立刻全量 download-candles
#    → /api/stock 餓死、走圖載不出（病徵：三色秒回但 K 線轉圈、CPU idle）。
#    資料「還沒下載完」的時段（盤中/剛收盤）重啟最慘；資料「已下載完」的時段重啟，
#    boot 觸發的 download 多半 skip(已新) → 不風暴。
#
# 安全窗口（CST）：TW 收盤下載完(≥17:00) 且 CN 收盤下載完(≥18:30)，或週末非交易日。
#
# 用法：
#   sh scripts/deploy-prod-guard.sh           # 安全模式：非安全窗口直接擋下
#   sh scripts/deploy-prod-guard.sh --force   # 跳過時機檢查（自負風暴風險）
#   sh scripts/deploy-prod-guard.sh --maintenance
#         # 緊急模式：先 DISABLE_LOCAL_CRON=1 再重啟 → 不風暴但「管線停擺」；
#         #           跑完會大聲提醒你之後要 unset + 再重啟一次（在安全窗口）才恢復管線。

set -e
LABEL="com.rockstock.prod-server"
UID_="$(id -u)"
ROOT="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd -P)"
export PATH="$HOME/.local/node-22/bin:$PATH"

FORCE=0
MAINT=0
for a in "$@"; do
  [ "$a" = "--force" ] && FORCE=1
  [ "$a" = "--maintenance" ] && MAINT=1
done

# ── 時機把關 ───────────────────────────────────────────────────────────────
HHMM_TW="$(TZ=Asia/Taipei date +%H%M)"
WD="$(TZ=Asia/Taipei date +%u)"   # 1=Mon .. 7=Sun
echo "現在 CST：$(TZ=Asia/Taipei date '+%Y-%m-%d %H:%M (週%u)')"
IS_WEEKEND=0
[ "$WD" -ge 6 ] && IS_WEEKEND=1
# 交易日的安全窗口：CST ≥ 18:30（CN final download 已過）才算資料齊
SAFE=0
[ "$IS_WEEKEND" = "1" ] && SAFE=1
[ "$HHMM_TW" -ge 1830 ] && SAFE=1
if [ "$SAFE" = "0" ] && [ "$FORCE" = "0" ] && [ "$MAINT" = "0" ]; then
  echo "✗ 現在不是安全窗口（需週末，或 CST ≥ 18:30 資料下載完）。"
  echo "  此刻重啟可能觸發 download-candles 風暴、走圖載不出。"
  echo "  要照樣跑：加 --force（自負風險）或 --maintenance（管線先停、不風暴）。"
  exit 1
fi

# ── 緊急模式：先停 local-cron 再重啟（不風暴，但管線停擺）────────────────────
if [ "$MAINT" = "1" ]; then
  echo "→ [maintenance] launchctl setenv DISABLE_LOCAL_CRON 1（重啟後管線會停！）"
  launchctl setenv DISABLE_LOCAL_CRON 1
else
  # 確保常態：不要殘留 DISABLE_LOCAL_CRON（否則重啟後管線整條不跑）
  launchctl unsetenv DISABLE_LOCAL_CRON 2>/dev/null || true
fi

# ── 旁路 build ─────────────────────────────────────────────────────────────
# 不直接在 production 正在讀取的 .next 上 build。Next build 一開始會清 distDir；
# 若編譯失敗，舊做法會讓存活中的 server 找不到靜態檔，頁面就可能整片黑。
cd "$ROOT"
STAGE_DIR="$ROOT/.next-deploy"
BACKUP_DIR="$ROOT/.next-before-deploy"
SWAPPED=0

rollback_on_error() {
  status="$?"
  if [ "$status" -ne 0 ] && [ "$SWAPPED" = "1" ]; then
    echo "✗ 新版啟動失敗，還原上一版 .next ..."
    rm -rf "$ROOT/.next"
    if [ -d "$BACKUP_DIR" ]; then
      mv "$BACKUP_DIR" "$ROOT/.next"
      launchctl kickstart -k "gui/$UID_/$LABEL" 2>/dev/null || true
    fi
  fi
  exit "$status"
}
trap rollback_on_error EXIT INT TERM

rm -rf "$STAGE_DIR" "$BACKUP_DIR"
echo "→ NEXT_DEPLOY_BUILD=1 npm run build（旁路：.next-deploy）..."
NEXT_DEPLOY_BUILD=1 npm run build

# build 完整成功後才切換；兩次 rename 的空窗極短，舊 .next 會保留到健康檢查通過。
[ -d "$ROOT/.next" ] && mv "$ROOT/.next" "$BACKUP_DIR"
mv "$STAGE_DIR" "$ROOT/.next"
SWAPPED=1

# ── log rotation ───────────────────────────────────────────────────────────
# launchd itself does not rotate StandardOutPath/StandardErrorPath. Rotate
# immediately before kickstart so the new process opens fresh files.
rotate_log() {
  file="$1"
  [ -f "$file" ] || return 0
  size="$(stat -f %z "$file" 2>/dev/null || echo 0)"
  [ "$size" -lt 5242880 ] && return 0
  stamp="$(date '+%Y%m%d-%H%M%S')"
  mv "$file" "${file}.${stamp}"
  echo "→ 已輪替 ${file}（${size} bytes）"
}
rotate_log /tmp/rockstock-prod.log
rotate_log /tmp/rockstock-prod.err.log

# Keep deployment rotations bounded. The timestamp suffix is created only by
# rotate_log above; retain the five newest files for incident review.
prune_rotated_logs() {
  file="$1"
  logical_dir="$(dirname "$file")"
  dir="$(CDPATH= cd -- "$logical_dir" && pwd -P)"
  base="$(basename "$file")"
  find "$dir" -maxdepth 1 -type f -name "${base}.20??????-??????" -print 2>/dev/null \
    | sort -r \
    | awk 'NR > 5' \
    | while IFS= read -r old_log; do
        [ -n "$old_log" ] || continue
        rm -f -- "$old_log"
        echo "→ 已清除過期輪替 ${old_log}"
      done
}
prune_rotated_logs /tmp/rockstock-prod.log
prune_rotated_logs /tmp/rockstock-prod.err.log

# ── 重啟 ───────────────────────────────────────────────────────────────────
echo "→ launchctl kickstart -k gui/$UID_/$LABEL ..."
launchctl kickstart -k "gui/$UID_/$LABEL"

# ── 健康檢查：等 server 回 200，再逐一驗證首頁引用的 chunks ───────────────
echo "→ 健康檢查（最多 90s）..."
ok=0
i=0
while [ "$i" -lt 45 ]; do
  code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 http://localhost:3000/ 2>/dev/null || echo 000)"
  if [ "$code" = "200" ]; then ok=1; break; fi
  i=$((i+1)); sleep 2
done
if [ "$ok" = "1" ]; then
  echo "✓ server 已起（HTTP 200）"
else
  echo "✗ 90s 內沒等到 200（code=$code）— 將自動回復上一版"
  exit 1
fi

echo "→ 驗證首頁引用的 Next.js 靜態資源 ..."
if ! node "$ROOT/scripts/verify-next-assets.mjs" "http://localhost:3000"; then
  echo "✗ 首頁雖回 200，但靜態資源不完整 — 將自動回復上一版"
  exit 1
fi

# npm 不會把 launchd 的 SIGTERM 完整轉交給 next-server；舊 server 因而可能變成
# PPID=1、已不監聽任何 port，卻繼續跑 local-cron。只清理「同 repo cwd + PPID=1
# + next-server + 無 LISTEN socket」的孤兒，絕不碰目前 :3000 listener 或 preview。
cleanup_orphan_next_servers() {
  orphan_pids="$(ps -Ao pid=,ppid=,command= | awk '$2 == 1 && index($0, "next-server") { print $1 }')"
  [ -n "$orphan_pids" ] || return 0

  for orphan_pid in $orphan_pids; do
    orphan_cwd="$(lsof -a -p "$orphan_pid" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p' | head -1)"
    [ "$orphan_cwd" = "$ROOT" ] || continue

    if lsof -nP -a -p "$orphan_pid" -iTCP -sTCP:LISTEN 2>/dev/null | grep -q LISTEN; then
      continue
    fi

    echo "→ 清理舊 next-server 孤兒 PID $orphan_pid（不監聽 port、仍會跑 cron）"
    kill -TERM "$orphan_pid" 2>/dev/null || continue
    waited=0
    while kill -0 "$orphan_pid" 2>/dev/null && [ "$waited" -lt 5 ]; do
      sleep 1
      waited=$((waited + 1))
    done
    if kill -0 "$orphan_pid" 2>/dev/null; then
      kill -KILL "$orphan_pid" 2>/dev/null || true
    fi
  done
}
cleanup_orphan_next_servers

# 新版已健康，上一版 build 才可清除；關閉錯誤回復 trap。
rm -rf "$BACKUP_DIR"
SWAPPED=0
trap - EXIT INT TERM

# ── 清 L1 cache（讓剛改的資料/碼即時生效）──────────────────────────────────
SECRET="$(grep -E '^CRON_SECRET=' "$ROOT/.env.local" 2>/dev/null | head -1 | cut -d= -f2- | tr -d '"' | tr -d "'" | xargs)"
if [ -n "$SECRET" ]; then
  echo "→ 清 L1 cache ..."
  curl -s -H "Authorization: Bearer $SECRET" http://localhost:3000/api/admin/clear-l1-cache || true
  echo
fi

# ── 收尾提醒 ───────────────────────────────────────────────────────────────
if [ "$MAINT" = "1" ]; then
  echo ""
  echo "🚨🚨🚨 [maintenance] DISABLE_LOCAL_CRON=1 仍生效，資料管線目前【停擺】！"
  echo "    等到安全窗口（週末 / CST ≥18:30）務必執行以恢復："
  echo "      launchctl unsetenv DISABLE_LOCAL_CRON"
  echo "      launchctl kickstart -k gui/$UID_/$LABEL"
fi
echo "完成。驗證：開 /?load=6190 看走圖是否正常載入、無風暴。"
