#!/bin/zsh
# 每晚 23:55 CST 自動跑 /youtube-analysis,且先補抓「晚場」後才分析。
#
# ⚠️ 此檔刻意放在 ~/.local/bin(非 iCloud 同步路徑)。原本放 ~/Desktop/rockstock/scripts/
#    會被 iCloud「最佳化 Mac 儲存空間」evict 成 dataless 佔位檔,launchd 背景代理無法 fault-in
#    → zsh「can't open input file」→ 每晚靜默失敗。放 ~/.local 永不被 evict。
#    (Desktop 那份 scripts/youtube-nightly-analysis.sh 留作參考,改邏輯請改「這份」。)
#
# 為什麼要補抓:錢線百分百「下集」23:30 才上片。當日最後一次 target=今日 的掃描在 23:00
# (下集還沒上),之後凌晨的掃描又 target 隔日 → 下集被判 wrong_date 永遠不分析。
# 解法:23:55 先「只」force 重掃錢線(ustvmoney100)撈進 23:30 下集 + 抓它的逐字稿
# (錢線有 zh-Hant 自動字幕,~8s 快;沒好才 fallback Whisper),再 prepare、才分析。
#
# 為什麼只掃錢線、不掃全部:force 重掃全 17 來源要 >200s 會 timeout、且 curl 中止後
# server 仍背景跑造成步驟重疊(多 cron 並行陷阱)。其他 16 檔白天每小時 cron 已掃完,
# 23:00 後唯一新上的晚場就是錢線下集 → 單來源補掃幾十秒即可。
# (若日後發現別的節目也常 23:00 後才上,把 source_id 加進 LATE_SRC 即可。)
#
# 日期 D 開頭鎖一次全程沿用 → 即使 Whisper 拖過午夜,分析的仍是「今日」交易日不漂。
# 認證:claude 走 Keychain「Claude Code-credentials」(訂閱);plist 須給 HOME/USER/LOGNAME,
#       絕不可設 ANTHROPIC_API_KEY(會改走 API 付費)。
set -u
export PATH="/Users/tc/.local/node-22/bin:/Users/tc/.local/bin:/usr/local/bin:/usr/bin:/bin"
export TZ="Asia/Taipei"

D=$(date +%F)
BASE="http://localhost:3000/api/cron"
AUTH="Authorization: Bearer CRON_SECRET"
LATE_SRC="ustvmoney100"   # 錢線百分百:下集 23:30 才上
ts() { date '+%H:%M:%S'; }
echo "=== [$(ts)] youtube nightly analysis 開始, date=$D ==="

# 1) 只 force 重掃晚場來源(撈 23:30 下集;單來源,快)
curl -fsS --max-time 90 -H "$AUTH" -X POST "$BASE/youtube-scan?date=$D&force=1&source_id=$LATE_SRC" >/dev/null 2>&1 \
  && echo "[$(ts)] scan($LATE_SRC) OK" || echo "[$(ts)] scan 失敗(略過,繼續)"

# 2) 抓該來源今日逐字稿(自動字幕優先;沒好才 Whisper,故 max-time 放寬到 15min)
curl -fsS --max-time 900 -H "$AUTH" -X POST "$BASE/youtube-transcript?date=$D&source_id=$LATE_SRC&use_whisper=1" >/dev/null 2>&1 \
  && echo "[$(ts)] transcript($LATE_SRC) OK" || echo "[$(ts)] transcript 失敗(略過,繼續)"

# 2.5) 補抽晚場來源關鍵幀(錢線下集是 keyframe_enabled 來源;白天集數 hourly cron 已抽完。
#      ~3min/支;失敗不致命,純逐字稿分析照常)
curl -fsS --max-time 600 -H "$AUTH" -X POST "$BASE/youtube-keyframes?date=$D&source_id=$LATE_SRC" >/dev/null 2>&1 \
  && echo "[$(ts)] keyframes($LATE_SRC) OK" || echo "[$(ts)] keyframes 失敗(略過,繼續)"

# 3) 重寫 question payload(含剛補進的下集;全來源,純檔案 I/O 快)
curl -fsS --max-time 120 -H "$AUTH" -X POST "$BASE/youtube-prepare-analysis?date=$D" >/dev/null 2>&1 \
  && echo "[$(ts)] prepare OK" || echo "[$(ts)] prepare 失敗(略過,繼續)"

# 4) headless claude 分析(讀剛寫好的當日 question.json → 寫 data/youtube/analysis/$D.json)
#    ⚠️ 加重試(2026-06-08 教訓):headless claude 偶爾遇暫時性 API 斷線
#    (`API Error: The socket connection was closed unexpectedly`)就死、整天沒產出。
#    且 headless claude 即使 API Error 也可能 exit 0 → 不能只看 $?。
#    成功判準 = analysis 檔「在本次嘗試之後」才被寫出且 size > 1KB。
#    不用 exec(exec 取代 shell 就無法包重試)。絕不可設 ANTHROPIC_API_KEY(會改走 API 付費)。
echo "=== [$(ts)] 開始 claude 分析 ==="
cd /Users/tc/Desktop/rockstock || exit 1

ANALYSIS_FILE="/Users/tc/Desktop/rockstock/data/youtube/analysis/$D.json"
CLAUDE_BIN="/Users/tc/.local/node-22/bin/claude"
MAX_TRIES=3

# 成功 = 檔案存在、mtime >= 本次嘗試起點、size > 1024 bytes(macOS BSD stat)
analysis_ok() {
  local start_epoch=$1 mtime size
  [[ -f "$ANALYSIS_FILE" ]] || return 1
  mtime=$(stat -f %m "$ANALYSIS_FILE" 2>/dev/null) || return 1
  size=$(stat -f %z "$ANALYSIS_FILE" 2>/dev/null) || return 1
  [[ "$mtime" -ge "$start_epoch" && "$size" -gt 1024 ]]
}

success=0
for (( i=1; i<=MAX_TRIES; i++ )); do
  # 失敗後遞增退避(第 1 次不睡):0s → 30s → 120s
  case $i in 1) sleep_s=0 ;; 2) sleep_s=30 ;; *) sleep_s=120 ;; esac
  if (( sleep_s > 0 )); then
    echo "[$(ts)] 前次未產出,睡 ${sleep_s}s 後重試"
    sleep "$sleep_s"
  fi
  attempt_start=$(date +%s)
  echo "[$(ts)] claude 分析嘗試 $i/$MAX_TRIES ..."
  "$CLAUDE_BIN" -p "/youtube-analysis" --model opus --permission-mode bypassPermissions
  rc=$?
  if analysis_ok "$attempt_start"; then
    echo "=== [$(ts)] ✅ 分析成功(嘗試 $i, claude exit=$rc, 已產出 $ANALYSIS_FILE) ==="
    success=1
    break
  fi
  echo "[$(ts)] ⚠️ 嘗試 $i 未產出 analysis(claude exit=$rc, $ANALYSIS_FILE 未更新)" >&2
done

if (( success == 0 )); then
  echo "=== [$(ts)] ❌ claude 分析連 $MAX_TRIES 次都失敗, $D 無 analysis 產出 ===" >&2
  echo "[$(ts)] 排錯:question 在 \$TMPDIR/rockstock-youtube/$D-question.json;可手動於對話跑 /youtube-analysis $D 補出" >&2
  exit 1
fi

# 4.5) 確定性正規化(2026-06-13):headless claude 寫的 analysis 偶爾漂出三類違規
#    (名稱異體字台→臺 / screenshot_ref 絕對路徑 / recommendation_type 自創枚舉)。
#    skill 的「最後一步呼叫 normalize」是 LLM 自由裁量、會漏(2026-06-12 漏了整份)
#    → 把保證從 LLM 移到這支確定性 wrapper。代號重查 + keyframe 欄位修正 + 大聲自查。
#    exit 2 = 仍有無法機械修的(需人工);不致命(analysis 仍可用,reco-events 照抽),只記錄。
echo "=== [$(ts)] 正規化 analysis ==="
if npx tsx scripts/normalize-youtube-analysis.ts "$D"; then
  echo "[$(ts)] normalize OK"
else
  echo "[$(ts)] ⚠️ normalize 回非零(可能有無法自動修的殘留,見上方明細,需人工複查)" >&2
fi

# 5) 抽老師推薦事件(analysis → recommendations/$D.json;基準價隔日 15:30 settle cron 再結)
#    失敗不致命:reco-events route 每次都會 sweep 近 3 天,明天 15:30 會自動補抽。
curl -fsS --max-time 120 -H "$AUTH" -X POST "$BASE/youtube-reco-events?date=$D" >/dev/null 2>&1 \
  && echo "[$(ts)] reco-events OK" || echo "[$(ts)] reco-events 失敗(略過,15:30 settle cron 會補)"

echo "=== [$(ts)] youtube nightly analysis 完成, date=$D ==="
exit 0
