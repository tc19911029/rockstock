#!/usr/bin/env bash
# transcribe-yt.sh — 一鍵 YouTube → 高品質中文逐字稿
#
# 用法：
#   ./scripts/transcribe-yt.sh <youtube-url>
#   ./scripts/transcribe-yt.sh <youtube-url> --model medium     # 默認 large-v3-turbo
#   ./scripts/transcribe-yt.sh <youtube-url> --keep-audio       # 保留 mp3
#
# 輸出：
#   data/youtube/transcripts/manual/<YYYY-MM-DD>/<video_id>.json    # 結構化 + 校正
#   data/youtube/transcripts/manual/<YYYY-MM-DD>/<video_id>.md      # 易讀 markdown
#
# 流程：yt-dlp metadata → yt-dlp 抓 mp3 → mlx-whisper → 校正錯字 → 落地

set -euo pipefail

# 強制載入 node-22 PATH（從 memory：env_node_setup）
export PATH="/Users/tc/.local/node-22/bin:/Users/tc/.local/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"

# ── 參數
URL=""
MODEL="large-v3-turbo"
KEEP_AUDIO=0
while [[ $# -gt 0 ]]; do
    case "$1" in
        --model) MODEL="$2"; shift 2 ;;
        --keep-audio) KEEP_AUDIO=1; shift ;;
        --help|-h)
            head -16 "$0" | tail -15
            exit 0
            ;;
        *)
            if [[ -z "$URL" ]]; then URL="$1"; shift
            else echo "未知參數: $1" >&2; exit 1
            fi
            ;;
    esac
done

if [[ -z "$URL" ]]; then
    echo "用法: $0 <youtube-url>" >&2
    exit 1
fi

# ── 找 repo 根
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

# ── Step 1: 抓 metadata
echo ">> 抓 YouTube metadata..."
META_JSON=$(yt-dlp --dump-json --skip-download --no-warnings "$URL" 2>/dev/null)
VIDEO_ID=$(echo "$META_JSON" | node -e 'console.log(JSON.parse(require("fs").readFileSync(0,"utf-8")).id)')
TITLE=$(echo "$META_JSON" | node -e 'console.log(JSON.parse(require("fs").readFileSync(0,"utf-8")).title)')
UPLOADER=$(echo "$META_JSON" | node -e 'console.log(JSON.parse(require("fs").readFileSync(0,"utf-8")).uploader || "")')
UPLOAD_DATE=$(echo "$META_JSON" | node -e 'const d=JSON.parse(require("fs").readFileSync(0,"utf-8")).upload_date||""; console.log(d ? d.slice(0,4)+"-"+d.slice(4,6)+"-"+d.slice(6,8) : new Date().toISOString().slice(0,10))')
DURATION=$(echo "$META_JSON" | node -e 'console.log(JSON.parse(require("fs").readFileSync(0,"utf-8")).duration||0)')

echo "   id=$VIDEO_ID"
echo "   title=$TITLE"
echo "   uploader=$UPLOADER"
echo "   upload_date=$UPLOAD_DATE"
echo "   duration=${DURATION}s ($((DURATION/60)) min)"

# ── 工作目錄
WORK_DIR="/tmp/yt-${VIDEO_ID}"
mkdir -p "$WORK_DIR"
AUDIO="$WORK_DIR/audio.mp3"

# ── Step 2: 抓音檔（若已存在跳過）
# Whisper 內部會 resample 到 16kHz mono；所以最低品質 mono 32kbps 就夠用，省 60%+ 空間
if [[ -f "$AUDIO" ]]; then
    echo ">> 音檔已存在，跳過下載: $AUDIO"
else
    echo ">> 下載音檔（mono 32kbps，Whisper 用足夠）..."
    yt-dlp -f bestaudio -x --audio-format mp3 --audio-quality 9 \
        --postprocessor-args "ffmpeg:-ac 1 -ar 16000 -b:a 32k" \
        -o "$WORK_DIR/audio.%(ext)s" --no-warnings "$URL" 2>&1 | tail -3
fi

# ── Step 3: mlx-whisper 轉錄
echo ">> 跑 mlx-whisper ($MODEL)，預計 5-15 分鐘..."
python3 "$REPO_ROOT/scripts/_yt_transcribe.py" "$AUDIO" "$WORK_DIR" "$MODEL"

# ── Step 4: 校正同音錯字 + 落地
echo ">> 校正錯字 + 寫入專案..."
OUT_DIR="$REPO_ROOT/data/youtube/transcripts/manual/$UPLOAD_DATE"
mkdir -p "$OUT_DIR"

# 用 tsx 跑校正 + markdown 輸出
npx --yes tsx "$REPO_ROOT/scripts/correct-transcript.ts" \
    --in "$WORK_DIR/segments.json" \
    --video-id "$VIDEO_ID" \
    --title "$TITLE" \
    --uploader "$UPLOADER" \
    --upload-date "$UPLOAD_DATE" \
    --duration "$DURATION" \
    --url "$URL" \
    --out-json "$OUT_DIR/${VIDEO_ID}.json" \
    --out-md "$OUT_DIR/${VIDEO_ID}.md"

# ── Step 5: 清理
if [[ "$KEEP_AUDIO" -eq 0 ]]; then
    rm -f "$AUDIO"
    echo ">> 清理 mp3 (用 --keep-audio 保留)"
fi

echo ""
echo "✓ 完成！"
echo "   JSON:     $OUT_DIR/${VIDEO_ID}.json"
echo "   Markdown: $OUT_DIR/${VIDEO_ID}.md"
echo ""
echo "   開啟 markdown：open \"$OUT_DIR/${VIDEO_ID}.md\""
