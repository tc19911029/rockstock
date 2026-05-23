#!/bin/zsh
# 每日 13:00 CST 提醒 — 留 20 分鐘給「資料抓不到」這種狀況補救
#
# 行為：
#   1. pre-fetch 今日 portfolio-review question.json（給 13:20 那邊用）
#   2. 抓 growth-status 看本月進度
#   3. 算 3 檔現價 vs MA5
#   4. 推 macOS 桌面通知，內含「該不該出」一句話結論
#
# 注意：launchd PATH 不含 user shell，明確 export
export PATH="$HOME/.local/node-22/bin:$HOME/.local/bin:/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin"

D=$(TZ=Asia/Taipei date +%F)
H=$(TZ=Asia/Taipei date +%H:%M)
LOG="$HOME/Library/Logs/rockstock-lunch-reminder.log"

log() { echo "[$(date +%FT%T)] $*" >> "$LOG"; }

log "=== 13:00 reminder start ($D $H CST) ==="

# 1. pre-fetch portfolio-review question.json
PREP=$(curl -fsS --max-time 30 -X POST "http://localhost:3000/api/agents/portfolio/review?date=$D" 2>&1)
log "prepare review: $PREP"

# 2. 抓 growth-status
GROWTH=$(curl -fsS --max-time 10 "http://localhost:3000/api/portfolio/growth-status" 2>&1)
log "growth-status: $GROWTH"

# 3. 算 3 檔 MA5 vs 現價（用 Python）
ANALYSIS=$(python3 << 'EOF' 2>/dev/null
import json, sys, os, glob

ROCK = os.environ.get('HOME') + '/Desktop/rockstock'
os.chdir(ROCK)

# 讀 holdings
try:
    with open('data/agents/portfolio/holdings.json') as f:
        H = json.load(f)['holdings']
except Exception as e:
    print(f"❌ holdings.json 讀不到")
    sys.exit(0)

if not H:
    print("📭 無持股")
    sys.exit(0)

# 對每檔算 5/22 (或最新) close vs MA5
lines = []
for h in H:
    sym = h['symbol']
    market = h['market']
    sl = h.get('stopLoss', 0)
    try:
        with open(f'data/candles/{market}/{sym}.json') as f:
            d = json.load(f)
        candles = d['candles']
        last = candles[-1]
        ma5 = sum(c['close'] for c in candles[-5:]) / 5
        close = last['close']
        last_date = last['date']
        # 資料新鮮度：last_date 跟今日是否同（盤後才會更新）
        # 簡單版：last_date < today-3 days → 提示資料舊
        # 判斷
        return_pct = (close - h['entryPrice']) / h['entryPrice'] * 100
        if return_pct >= 10:
            # 進入 MA5 停利模式
            if close < ma5:
                lines.append(f"⚠ {sym[:4]} 跌破 MA5 {ma5:.0f}（現價 {close}）→ 1:25 全出")
            else:
                lines.append(f"✓ {sym[:4]} {close} 站 MA5 {ma5:.0f} 上 → 抱")
        else:
            # 看停損
            if close < sl:
                lines.append(f"⚠ {sym[:4]} 跌破停損 {sl}（現價 {close}）→ 1:25 全出")
            else:
                lines.append(f"✓ {sym[:4]} {close} 站停損 {sl} 上 → 抱")
    except Exception as e:
        lines.append(f"❓ {sym[:4]} 資料缺")

print("\n".join(lines))
EOF
)
log "analysis: $ANALYSIS"

# 4. 大盤狀態
MARKET=$(python3 << 'EOF' 2>/dev/null
import json, os
os.chdir(os.environ['HOME'] + '/Desktop/rockstock')
try:
    with open('data/candles/TW/^TWII.json') as f:
        d = json.load(f)
    c = d['candles']
    last = c[-1]
    ma20 = sum(x['close'] for x in c[-20:]) / 20
    state = "🟢 多頭" if last['close'] > ma20 else "🔴 空頭警示"
    print(f"加權 {last['close']:.0f} {state}（MA20 {ma20:.0f}）")
except Exception:
    print("加權資料缺")
EOF
)

# 5. 推通知
TITLE="🔔 13:00 該看持股了"
SUBTITLE="20 分鐘後 13:20 決策、13:25 動作"
BODY="$ANALYSIS

$MARKET"

# 寫到 stdout 給 log
echo "$TITLE / $SUBTITLE" >> "$LOG"
echo "$BODY" >> "$LOG"

# osascript 桌面通知（macOS 預設不允許多行 body，用 \n 替代）
BODY_ONELINE=$(echo "$BODY" | tr '\n' ' ' | sed 's/  */ /g')
osascript -e "display notification \"$BODY_ONELINE\" with title \"$TITLE\" subtitle \"$SUBTITLE\" sound name \"Glass\""

# 同步開瀏覽器到 /portfolio（如果你想要）
# open "http://localhost:3000/portfolio"

log "=== reminder done ==="
