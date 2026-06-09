#!/bin/zsh
# 每晚 23:55 CST 自動跑 /youtube-analysis,且先補抓「晚場」後才分析。
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

# 3) 重寫 question payload(含剛補進的下集;全來源,純檔案 I/O 快)
curl -fsS --max-time 120 -H "$AUTH" -X POST "$BASE/youtube-prepare-analysis?date=$D" >/dev/null 2>&1 \
  && echo "[$(ts)] prepare OK" || echo "[$(ts)] prepare 失敗(略過,繼續)"

# 4) headless claude 分析(讀剛寫好的當日 question.json → 寫 data/youtube/analysis/$D.json)
echo "=== [$(ts)] 開始 claude 分析 ==="
cd /Users/tc/Desktop/rockstock || exit 1
exec /Users/tc/.local/node-22/bin/claude -p "/youtube-analysis" --model opus --permission-mode bypassPermissions
