#!/bin/zsh
# YouTube 抓片狀況巡檢 — 每小時 14-23 CST 跑一次
#
# 輸出到 /tmp/rockstock-youtube-status.log
# 你可以 `tail -f /tmp/rockstock-youtube-status.log` 持續看
#
# 跟系統 scan/transcript/prepare-analysis cron 的差別：
#   - 他們負責「跑」， 這支負責「印出當下狀態」
#   - 如果發現 should_analyze=true 但還沒抓 transcript，會 trigger transcript fetch（含 Whisper）
#   - 寫的 log 對人類友善，不需要去翻 JSON

set -u  # 嚴格未定義變數

D=$(TZ=Asia/Taipei date +%F)
HH=$(TZ=Asia/Taipei date +%H:%M)
TS="[$D $HH]"
ROOT=$HOME/Desktop/rockstock
VIDEOS_FILE=$ROOT/data/youtube/videos/$D.json
TRANSCRIPTS_DIR=$ROOT/data/youtube/transcripts/$D
ANALYSIS_FILE=$ROOT/data/youtube/analysis/$D.json

# 沒影片檔 = 今日還沒抓到任何片
if [ ! -f "$VIDEOS_FILE" ]; then
  echo "$TS 今日尚無影片檔（$D）"
  exit 0
fi

# 算 analyzable 數
ANALYZABLE=$(/usr/bin/python3 -c "
import json
with open('$VIDEOS_FILE') as f:
    vids = json.load(f)
print(sum(1 for v in vids if v.get('should_analyze')))
")
TOTAL=$(/usr/bin/python3 -c "
import json
with open('$VIDEOS_FILE') as f:
    vids = json.load(f)
print(len(vids))
")

# 算已抓 transcript 的數量
if [ -d "$TRANSCRIPTS_DIR" ]; then
  TRANSCRIPTS=$(ls -1 "$TRANSCRIPTS_DIR" 2>/dev/null | grep -c '\.json$')
else
  TRANSCRIPTS=0
fi

# analysis 寫了沒
if [ -f "$ANALYSIS_FILE" ]; then
  ANALYSIS_STATUS="✅ 已寫"
else
  ANALYSIS_STATUS="⏳ 尚未寫"
fi

# 如果 analyzable 數 > transcript 數，trigger transcript fetch（含 Whisper fallback）
TRANSCRIPT_ACTION=""
if [ "$ANALYZABLE" -gt "$TRANSCRIPTS" ]; then
  PENDING=$((ANALYZABLE - TRANSCRIPTS))
  TRANSCRIPT_ACTION=" → 偵測 $PENDING 支待抓字幕，觸發 transcript fetch"
  /usr/bin/curl -fsS --max-time 280 \
    -H "Authorization: Bearer CRON_SECRET" \
    -X POST "http://localhost:3000/api/cron/youtube-transcript?date=$D&use_whisper=1" \
    > /dev/null 2>&1 || TRANSCRIPT_ACTION="$TRANSCRIPT_ACTION (curl failed)"
  # 重新數一次
  sleep 2
  if [ -d "$TRANSCRIPTS_DIR" ]; then
    TRANSCRIPTS=$(ls -1 "$TRANSCRIPTS_DIR" 2>/dev/null | grep -c '\.json$')
  fi
fi

# 印 status
echo "$TS 今日 $D：影片 $TOTAL 支 / analyzable $ANALYZABLE 支 / transcript $TRANSCRIPTS 支 / analysis $ANALYSIS_STATUS$TRANSCRIPT_ACTION"
