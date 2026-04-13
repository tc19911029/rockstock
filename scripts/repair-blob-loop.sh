#!/bin/bash
# 修復 Vercel Blob TW + CN 到 2026-04-13
# 用 staleThreshold=2 確保抓到 4/10 之前的落後股票

log() { echo "[$(date '+%H:%M:%S')] $*" | tee -a /tmp/blob-repair.log; }

cd /Users/tzu-chienhsu/Desktop/rockstock

# ─── TW ─────────────────────────────────────────────────────────────────────
log "🇹🇼 開始修復 Vercel Blob TW..."
TW_BATCH=0
while true; do
  TW_BATCH=$((TW_BATCH + 1))
  RESP=$(vercel curl "/api/admin/repair-candles?market=TW&mode=repair&limit=30&staleThreshold=2" 2>/dev/null)
  UPDATED=$(echo "$RESP" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('updated',0))" 2>/dev/null || echo 0)
  REMAINING=$(echo "$RESP" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('remaining',0))" 2>/dev/null || echo 0)
  ERRORS=$(echo "$RESP" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('errors',0))" 2>/dev/null || echo 0)
  log "  TW batch #${TW_BATCH}: updated=${UPDATED} remaining=${REMAINING} errors=${ERRORS}"
  if [ "$REMAINING" -eq 0 ] || [ "$TW_BATCH" -ge 100 ]; then
    log "✅ TW Blob 修復完成 (${TW_BATCH} batches)"
    break
  fi
  sleep 8
done

# ─── CN ─────────────────────────────────────────────────────────────────────
log "🇨🇳 開始修復 Vercel Blob CN..."
CN_BATCH=0
while true; do
  CN_BATCH=$((CN_BATCH + 1))
  RESP=$(vercel curl "/api/admin/repair-candles?market=CN&mode=repair&limit=20&staleThreshold=2" 2>/dev/null)
  UPDATED=$(echo "$RESP" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('updated',0))" 2>/dev/null || echo 0)
  REMAINING=$(echo "$RESP" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('remaining',0))" 2>/dev/null || echo 0)
  ERRORS=$(echo "$RESP" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('errors',0))" 2>/dev/null || echo 0)
  log "  CN batch #${CN_BATCH}: updated=${UPDATED} remaining=${REMAINING} errors=${ERRORS}"
  if [ "$REMAINING" -eq 0 ] || [ "$CN_BATCH" -ge 20 ]; then
    log "✅ CN Blob 修復完成 (${CN_BATCH} batches)"
    break
  fi
  sleep 10
done

# ─── 最終診斷 ────────────────────────────────────────────────────────────────
log "🔍 最終診斷..."
TW_STALE=$(vercel curl "/api/admin/repair-candles?market=TW&mode=diagnose&staleThreshold=2" 2>/dev/null | python3 -c "import json,sys; d=json.load(sys.stdin); print('TW stale:', d.get('staleCount','?'))" 2>/dev/null)
CN_STALE=$(vercel curl "/api/admin/repair-candles?market=CN&mode=diagnose&staleThreshold=2" 2>/dev/null | python3 -c "import json,sys; d=json.load(sys.stdin); print('CN stale:', d.get('staleCount','?'))" 2>/dev/null)
log "  ${TW_STALE}"
log "  ${CN_STALE}"
log "✅ 全部完成！"
