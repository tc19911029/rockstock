# Taiwan Stock New Strategy Scanner Design Plan

## Status: COMPLETE

## Context
Design 3-4 new standalone scanners for Taiwan stocks, following the DabanScanner pattern (independent from the MarketScanner six-conditions pipeline). Each must be mechanically executable, backtestable with existing OHLCV data, and offer a fundamentally different paradigm from the current six-conditions scanner.

---

## Strategy Option 1: Smart K-Line Scanner (SmartKLineScanner)

### Overview
- **Name**: 聰明K線掃描器 (Smart K-Line Scanner)
- **One-line**: Pure price-action scanner — buy when close breaks prior-day high, exit when close breaks prior-day low.

### Why Different from Six-Conditions
The current six-conditions system requires ALL of: trend confirmation, MA alignment, position check, volume surge, K-bar quality, and oscillator alignment. That is a **multi-factor consensus model** with heavy lookback. Smart K-Line is the polar opposite: a **single-bar reactive model** that needs only 2 days of data and zero indicators. It trades more frequently but with tight stops, catching momentum continuation rather than waiting for full setup confirmation. It explicitly targets 7%+ per trade in 1-5 days, whereas six-conditions averages 3.2 days with much lower per-trade targets.

### Entry Conditions (Programmable)
```
LONG ENTRY (all must be true):
1. close[today] > high[yesterday]                    // Smart K-Line buy signal
2. trendSlope(10-bar) > 0.5                          // Trend angle > ~27 degrees (avoid flat markets)
3. close[today] > MA20[today]                        // Above monthly MA (basic trend filter)
4. volume[today] > avgVol5[today] * 1.0              // Not declining volume (relaxed: >= average)
5. (close[today] - low[today]) / (high[today] - low[today]) > 0.5   // Close in upper half of bar

ONE-DAY REVERSAL VARIANT (separate signal type):
1. 3+ consecutive days with close[i] < close[i-1]   // 3+ day decline
2. Today: long lower shadow OR hammer pattern        // Stop-signal K
3. Tomorrow: red K that breaks yesterday's high       // Reversal confirmation
4. close > MA20 * 0.85                               // Not in total freefall (deviation < 15%)
```

### Exit Rules
```
STOP-LOSS: close < low[entry_day_K]                  // Entry day K-line low
TAKE-PROFIT: unrealized gain >= 7%                   // Target per trade
TRAILING: once +5%, raise stop to entry_price        // Lock in breakeven
TIME STOP: max 5 trading days                        // Avoid dead money
SMART K EXIT: close < low[previous_day]              // The mirror rule
```

### Expected Holding Period
1-5 trading days. Most exits within 2-3 days (fast momentum trades).

### Ease of Implementation
**HIGH** — needs only OHLCV + MA20 + 5-bar average volume. All indicators already computed by `computeIndicators()`. No external data needed.

### Backtestability Score: 10/10
Fully mechanical. Zero discretion. Every condition is a simple numeric comparison on OHLCV data.

### Risk Profile vs Current System
- **Higher frequency**: ~3-5x more signals than six-conditions
- **Tighter stops**: Entry-day low vs current 3% fixed stop
- **Lower win rate expected**: ~30-35% (compensated by R:R ratio targeting 7% wins vs ~3% losses)
- **Worse in choppy markets**: Trend angle filter mitigates but doesn't eliminate
- **Better in strong trends**: Catches moves earlier than six-conditions

### Implementation Files
- `lib/scanner/SmartKLineScanner.ts` — Core scanner (standalone, no MarketScanner inheritance)
- `lib/scanner/types.ts` — Add `SmartKLineScanResult` and `SmartKLineScanSession` types
- `lib/storage/smartKLineStorage.ts` — Persistence (follow dabanStorage pattern)
- `app/api/scanner/smartkline/route.ts` — API route
- `scripts/scan-tw-smartkline.ts` — CLI script
- `scripts/backtest-tw-smartkline.ts` — Backtest script

---

## Strategy Option 2: Two MA Trend-Following Scanner (TwoMAScanner)

### Overview
- **Name**: 雙均線趨勢追蹤器 (Two MA Trend-Following Scanner)
- **One-line**: MA10+MA24 trend system — ride the wave while MA24 rises, exit on MA10 break.

### Why Different from Six-Conditions
Six-conditions uses MA alignment as ONE of six filters (all must pass). The Two MA scanner makes moving averages the ENTIRE system. It is a **trend-following regime model** that classifies market state into 3 regimes (both up / tangled / both down) and applies different rules per regime. The key paradigm shift: instead of a single entry signal, it generates **continuous state signals** — you are always either "in" or "out" based on MA position. This captures multi-week trends that six-conditions misses because it waits for a specific daily setup.

### Entry Conditions (Programmable)
```
LONG ENTRY (8 disciplines, simplified to programmable):
1. MA24[today] > MA24[5 days ago]                    // MA24 rising (the master condition)
2. close[today] > MA10[today]                        // Price above MA10
3. close[today] > MA24[today]                        // Price above MA24
4. MA10[today] > MA24[today]                         // Golden arrangement
5. close[yesterday] <= MA10[yesterday] OR             // Fresh breakout above MA10
   close[yesterday] <= MA24[yesterday]                // OR fresh breakout above MA24
6. volume[today] > avgVol5 * 1.2                     // Modest volume confirmation

REGIME FILTER (3 Iron Laws):
- BLOCKED if MA10 < MA24 AND MA24 declining          // Both down = don't buy
- CAUTION if |MA10 - MA24| / MA24 < 0.01             // Tangled = reduce position size flag
- WATCH if MA10 flat at high (slope < 0.1% over 5d)  // High-level stall

RE-ENTRY (after exit on MA10 break):
1. Previously held (within 20 days of last exit)
2. close[today] > MA10[today]                        // Reclaimed MA10
3. MA24[today] still rising                          // Master trend intact
4. volume[today] > avgVol5 * 1.0                     // Not dead volume

COUNTER-TREND REVERSAL (3 conditions):
1. MA10 < MA24 (bearish arrangement)
2. close crosses above MA10 from below
3. MA24 slope turning from negative to flat/positive (momentum shift)
```

### Exit Rules
```
PRIMARY EXIT: close < MA10 for 1 day                 // First break = sell first
HARD STOP: close < MA24                              // Trend broken
REGIME STOP: MA24 turns down (slope < 0 over 5d)     // Master trend over
TIME STOP: none (this is a trend-following system, can hold weeks)
RE-ENTRY: allowed if MA24 still rising (see above)
```

### Expected Holding Period
5-20 trading days. Some positions can run 30+ days in strong trends.

### Ease of Implementation
**HIGH** — needs MA10, MA24 (already computed as `ma10` and `ma24` in CandleWithIndicators), plus slope calculation (trivially derived from 5-day MA difference).

### Backtestability Score: 9/10
Almost fully mechanical. The "tangled" detection requires a small discretionary threshold for MA proximity, but this is parameterizable. Re-entry logic needs tracking of previous positions (adds state to backtest engine).

### Risk Profile vs Current System
- **Longer holding**: 5-20 days vs 3.2 days average
- **Lower frequency**: ~5-10 signals per month vs 20-30 from six-conditions
- **Higher win rate expected**: ~45-50% (trend-following captures big moves)
- **Larger drawdowns per trade**: MA10 stop is wider than 3% fixed stop
- **Compounding advantage**: Re-entry rule allows riding multi-month trends
- **Worse in range-bound markets**: Will get whipsawed on MA10 crosses

### Implementation Files
- `lib/scanner/TwoMAScanner.ts` — Core scanner with regime classification
- `lib/scanner/types.ts` — Add `TwoMAScanResult`, `TwoMAScanSession`, `MARegime` types
- `lib/storage/twoMAStorage.ts` — Persistence
- `app/api/scanner/twoma/route.ts` — API route
- `scripts/scan-tw-twoma.ts` — CLI script
- `scripts/backtest-tw-twoma.ts` — Backtest script (needs position state tracking)

---

## Strategy Option 3: Consolidation Breakout Scanner (BreakoutScanner)

### Overview
- **Name**: 盤整突破掃描器 (Consolidation Breakout Scanner)
- **One-line**: Detect 10-20 day tight consolidation ranges, then trigger on volume explosion + price breakout.

### Why Different from Six-Conditions
Six-conditions requires an EXISTING uptrend (trend = bullish, MAs aligned upward). Consolidation Breakout deliberately scans for stocks in NO trend — flat, boring, low-volatility consolidation — and catches the BEGINNING of a new move. This is a **volatility contraction/expansion model** inspired by Bollinger Band squeeze mechanics combined with Zhu's MA tangle detection. It finds opportunity in the exact stocks that six-conditions filters OUT (because they fail the trend and MA alignment conditions).

### Entry Conditions (Programmable)
```
CONSOLIDATION DETECTION (all must be true):
1. bbBandwidth[today] < bbBandwidth_percentile_20    // BB width in bottom 20% of 60-day lookback
   OR (high_20d - low_20d) / low_20d < 0.08          // 20-day range < 8% (tight box)
2. |MA5 - MA10| / MA10 < 0.01 AND                    // MA tangle zone (Zhu Book 1)
   |MA10 - MA20| / MA20 < 0.015
3. ATR14[today] / close < 0.02                        // Low daily volatility (< 2% ATR)
4. Duration: consolidation persists >= 10 trading days // Not a 2-day pause

BREAKOUT TRIGGER (on top of consolidation):
5. close[today] > max(high[past 20 days])             // Price breaks above range
6. volume[today] > avgVol20 * 2.0                     // Volume explosion (2x 20-day average)
7. close[today] > open[today]                         // Closes as a red (bullish) candle
8. (close - open) / (high - low) > 0.5                // Strong body (not doji)

QUALITY FILTERS:
9. close > MA60 OR MA60 is flat                       // Not breaking out into a major downtrend
10. Not in top 5% of 60-day price range               // Not already at highs (false breakout trap)
    Wait, this contradicts #5. Correction:
    Prior consolidation was NOT at 60-day high         // Breakout from base, not from peak
    i.e., low_20d < high_60d * 0.92                   // Consolidation at least 8% below 60-day peak
```

### Exit Rules
```
STOP-LOSS: close < low of consolidation range         // Break back into range = failed breakout
ALTERNATIVE STOP: -5% from entry (tighter protection)
TAKE-PROFIT: +10% from entry                          // Breakout targets tend to be larger
TRAILING STOP: after +7%, trail at MA5                // Let winners run with MA5 trail
TIME STOP: 10 trading days (if no meaningful move)
```

### Expected Holding Period
3-10 trading days. Successful breakouts typically resolve within a week.

### Ease of Implementation
**MEDIUM** — needs Bollinger Bandwidth (already computed: `bbBandwidth`), ATR14 (already computed: `atr14`), MA5/10/20/60 (all computed), and a rolling 20-day high/low calculation (trivial). The consolidation duration check requires a lookback loop but is straightforward.

### Backtestability Score: 10/10
All conditions are numeric comparisons on existing indicator data. Zero discretion. The 20-day range and BB percentile are fully computable from OHLCV.

### Risk Profile vs Current System
- **Very low frequency**: ~2-5 signals per month (consolidations are rare events)
- **High conviction**: When a genuine breakout occurs, the move tends to be large
- **Binary outcomes**: Breakouts either work (big gain) or fail immediately (stop hit)
- **Higher win rate expected for valid breakouts**: ~40-45%
- **Better risk/reward**: Tight stop (range low) vs large target (10%+)
- **Uncorrelated with six-conditions**: Finds opportunities in different market phases

### Implementation Files
- `lib/scanner/BreakoutScanner.ts` — Core scanner with consolidation detection
- `lib/scanner/types.ts` — Add `BreakoutScanResult`, `BreakoutScanSession` types
- `lib/storage/breakoutStorage.ts` — Persistence
- `app/api/scanner/breakout/route.ts` — API route
- `scripts/scan-tw-breakout.ts` — CLI script
- `scripts/backtest-tw-breakout.ts` — Backtest script

---

## Strategy Option 4: V-Shape Reversal Scanner (VReversalScanner)

### Overview
- **Name**: V型反轉掃描器 (V-Shape Reversal Scanner)  
- **One-line**: Counter-trend scanner — buy after 3+ day crash with extreme MA20 deviation, targeting snap-back to crash origin.

### Why Different from Six-Conditions
Six-conditions is inherently a **trend-following** system — it requires bullish trend, upward MAs, and momentum confirmation. V-Shape Reversal is a **mean-reversion** system that buys into FEAR. It looks for stocks that have crashed hard (3+ long black candles, deviation >= 15% below MA20) and catches the rubber-band snap-back. This is the only counter-trend strategy in the set and provides portfolio DIVERSIFICATION by profiting when trend-following systems are losing money.

### Entry Conditions (Programmable)
```
CRASH DETECTION (all must be true):
1. 3+ consecutive days where close[i] < close[i-1]     // 3+ day decline
2. Sum of 3-day decline >= -8%                          // Meaningful crash (not tiny dips)
3. (close - MA20) / MA20 <= -0.15                       // Deviation >= 15% below MA20
   OR (close - MA20) / MA20 <= -0.12 AND 5-day decline >= -12%

REVERSAL SIGNAL (on day after crash):
4. Gap down open: open[today] < low[yesterday]          // Gap down (panic selling exhausted)
5. Reversal candle:
   a. close[today] > open[today]                        // Bullish candle (red)
   b. (close - low) / (high - low) > 0.6               // Close in upper 40% of range
   c. lower shadow > 2 * body                           // Long lower shadow (hammer-like)
   OR body covers > 50% of yesterday's body (engulfing)
6. Volume: volume[today] > avgVol5 * 1.3               // Capitulation volume

SAFETY FILTERS:
7. close > MA60 * 0.75                                  // Not in terminal decline (still within recovery range)
8. Not limit-down today (change > -9.5%)                // Can still trade
9. MA20 was rising or flat 20 days ago                  // Was in uptrend before crash (not chronic decline)
```

### Exit Rules
```
TARGET: price reaches the crash start-point             // The "V" target (pre-crash high of 5-20d ago)
PARTIAL: take 50% at +5%, let rest run to target
STOP-LOSS: close < low[reversal_day_candle]             // Reversal failed
HARD STOP: -7% from entry                              // Maximum loss per trade
TIME STOP: 5 trading days (mean-reversion is fast)
```

### Expected Holding Period
2-5 trading days. Mean reversion trades are inherently short-duration.

### Ease of Implementation
**MEDIUM** — needs MA20 deviation (trivially computed), consecutive decline detection (loop), and reversal candle pattern recognition (already partially implemented in `zhuReversalRules.ts` and `smartKLineRules.ts`). Gap detection is a simple comparison.

### Backtestability Score: 9/10
Nearly fully mechanical. The crash start-point target calculation requires identifying the pre-crash swing high, which is a minor implementation detail (use `findPivots` from `trendAnalysis.ts`).

### Risk Profile vs Current System
- **Counter-trend**: Profits when trend-followers are losing — true diversification
- **Very low frequency**: ~1-3 signals per month (crashes are rare)
- **High win rate expected**: ~50-55% (extreme deviation reversals are statistically favorable)
- **Asymmetric risk**: Max loss 7%, potential gain 10-20% (snap-back to crash origin)
- **Psychologically difficult**: Buying into panic requires discipline
- **Market regime dependent**: Works best in bull markets with sharp corrections; dangerous in true bear markets (safety filter #9 mitigates)
- **Taiwan 10% limit advantage**: Daily limit caps the crash speed, making V-reversals more predictable than in unlimited markets

---

## Architecture Notes (Common to All)

### Scanner Pattern
Each scanner follows the DabanScanner standalone pattern:
1. **No MarketScanner inheritance** — independent `scan*()` function
2. **Input**: `Map<string, { name: string; candles: CandleWithIndicators[] }>`
3. **Output**: Custom `*ScanSession` type with results array
4. **Storage**: Follow `dabanStorage.ts` pattern (local fs + Vercel Blob)
5. **CLI**: Follow `scan-cn-daban.ts` pattern
6. **API**: Follow `app/api/scanner/daban/route.ts` pattern
7. **Backtest**: Standalone script using BacktestEngine's `TradeSignal` interface

### Data Requirements
All 4 strategies use ONLY OHLCV + indicators already computed by `computeIndicators()`:
- MA5, MA10, MA20, MA24, MA60 ✓
- KD(5,3,3), MACD(10,20,10) ✓
- Bollinger Bands (upper, lower, bandwidth, %B) ✓
- ATR14, RSI14, ROC10/20 ✓
- avgVol5, avgVol20 ✓

No new indicator computation needed. No external API dependencies.

### Backtest Integration
Each scanner can convert results to `TradeSignal` (via a custom converter similar to `scanResultToSignal` in BacktestEngine.ts), enabling use of the existing BacktestEngine with custom `ExitRule` configurations.

### Priority Recommendation
1. **Smart K-Line** (easiest, most mechanical, fastest to implement and validate)
2. **Consolidation Breakout** (highest expected edge, uncorrelated with existing scanner)
3. **V-Shape Reversal** (true diversifier, counter-trend)
4. **Two MA** (longest holding period, most complex state management for re-entry)

