#!/bin/bash
# YouTube pipeline 完整性 audit — 每次重做 5/18-5/22 後一定要跑
# 檢查三層：
#   1. videos.json 內的 analyzable 每支都有 transcript file（不靠 index，看 fs）
#   2. analysis.json 內的 mention raw_query 必須是真股票名（不是分析師名/概念詞）
#   3. analysis.json 提到的每個 stock_code 必須有對應 K 線檔
#
# 任一層失敗 → exit 非 0；CI 可掛這個。
# 用法：scripts/audit-youtube-pipeline.sh [date1 date2 ...]
#       不帶參數 → 預設 5/18-5/22

set -uo pipefail
cd "$(dirname "$0")/.."

DATES=("${@:-2026-05-18 2026-05-19 2026-05-20 2026-05-21 2026-05-22}")
DATES=($DATES)

# 已知不是股票的詞（白名單反面）
NON_STOCK='陳唯泰|鍾國忠|翁士峻|蔡明翰|容逸燊|權證小哥|朱家泓|王建文|不魯|林漢偉|李永年|楊雲翔|曲建仲|曲博|張錫|鄭明娟|阮慕驊|柯建維|高志銘|劉育綸|楚河|楚軒|王志郁|大盤|多頭|空頭|定海神針|崩盤|警訊|地雷|開洗'

fail=0

for d in "${DATES[@]}"; do
  # Layer 1: 影片 transcript 完整性
  layer1_miss=0
  while IFS= read -r vid; do
    [ -z "$vid" ] && continue
    if [ ! -f "data/youtube/transcripts/$d/$vid.json" ]; then
      # 也要查跨 date folder（舊 orphan 殘留）
      cross=$(find data/youtube/transcripts -name "$vid.json" -print -quit 2>/dev/null)
      if [ -z "$cross" ]; then
        echo "❌ [$d L1] missing transcript: $vid"
        layer1_miss=$((layer1_miss + 1))
        fail=$((fail + 1))
      fi
    fi
  done < <(jq -r '.[] | select(.should_analyze==true) | .video_id' "data/youtube/videos/$d.json" 2>/dev/null)
  [ $layer1_miss -eq 0 ] && echo "✓ [$d L1] all analyzable videos have transcripts"

  # Layer 2: 沒有人名/概念詞 mentions
  bad_kw=$(jq -r --arg re "$NON_STOCK" '[.high_consensus_stocks[]?, .weak_signal_stocks[]?] | map(select(.raw_query | test($re))) | length' "data/youtube/analysis/$d.json" 2>/dev/null)
  if [ "$bad_kw" -gt 0 ]; then
    echo "❌ [$d L2] $bad_kw 條 mention 是人名/概念詞，不該當股票"
    jq -r --arg re "$NON_STOCK" '[.high_consensus_stocks[]?, .weak_signal_stocks[]?] | map(select(.raw_query | test($re))) | .[] | "    · \(.raw_query)"' "data/youtube/analysis/$d.json"
    fail=$((fail + bad_kw))
  else
    echo "✓ [$d L2] no fake stock mentions"
  fi

  # Layer 3: stock_code 都有 K 線
  layer3_miss=0
  while IFS= read -r code; do
    [ -z "$code" ] && continue
    if [ ! -f "data/candles/TW/$code.TW.json" ]; then
      echo "❌ [$d L3] missing K-line: $code"
      layer3_miss=$((layer3_miss + 1))
      fail=$((fail + 1))
    fi
  done < <(jq -r '[.high_consensus_stocks[]?, .weak_signal_stocks[]?] | map(.matched.code) | unique | .[]' "data/youtube/analysis/$d.json" 2>/dev/null | grep -v '^null$')
  [ $layer3_miss -eq 0 ] && echo "✓ [$d L3] all mentioned stocks have K-line"
done

echo
if [ $fail -eq 0 ]; then
  echo "🎉 ALL CHECKS PASS"
else
  echo "⚠️  $fail issues found — fix above before declaring 'done'"
  exit 1
fi
