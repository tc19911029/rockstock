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
ROOT="$HOME/Desktop/rockstock"
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

# ── build ──────────────────────────────────────────────────────────────────
echo "→ npm run build ..."
cd "$ROOT"
npm run build

# ── 重啟 ───────────────────────────────────────────────────────────────────
echo "→ launchctl kickstart -k gui/$UID_/$LABEL ..."
launchctl kickstart -k "gui/$UID_/$LABEL"

# ── 健康檢查：等 server 回 200 ─────────────────────────────────────────────
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
  echo "✗ 90s 內沒等到 200（code=$code）— 自己檢查 launchctl print gui/$UID_/$LABEL 與 log"
fi

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
