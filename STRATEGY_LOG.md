# Strategy Optimization Log

## Scoring Formula

```
Score = (Annualized Return% × 0.4) + (Win Rate% × 0.3) - (Max Drawdown% × 0.3)
```

---

## Round 1 — Multi-Factor Scoring System (2026-03-29)

**Changes:**
- Created `smartMoneyScore.ts`: Smart money detection via OBV, volume asymmetry, CLV, gap patterns
- Added composite ranking: Tech 20% + Surge 25% + Smart Money 30% + Win Rate 25%
- Adaptive exit rules: S-grade stocks hold 8 days, D-grade 4 days
- Python engine: weighted scoring mode (chip 60% + fundamental 40%)

**New Factors:**
| Factor | Type | Description |
|--------|------|-------------|
| OBV Trend | Technical/Chip Proxy | On-Balance Volume uptrend detection |
| Volume Asymmetry | Technical/Chip Proxy | Up-day volume vs down-day volume ratio |
| Close Location Value | Technical | (close-low)/(high-low) buying pressure |
| Institutional Footprint | Technical/Chip Proxy | Gap-up patterns + controlled pullbacks |
| Revenue Momentum Proxy | Fundamental Proxy | 60-day performance + MA60 health |

**Strategy Configs Added:**
- `ZHU_V3_MULTIFACTOR` (generic): minScore=3, volRatio=1.3, KD≤90
- `ZHU_V3_TW` (Taiwan): smart money weight 35%, volRatio=1.4
- `ZHU_V3_CN` (A-share): surge weight 30%, volRatio=1.2, bear minScore=6

**Result:** Committed. Baseline established for multi-factor approach.

---

## Round 2 — Volume-Price Divergence + Mean Reversion (2026-03-29)

**Changes:**
- Added `volumePriceDivergence` component to surge score (10% weight)
- A-share mean reversion filter: blocks RSI>80 + 10d gain>15% entries
- Enhanced Python diagnoser with multi-factor analysis

**New Factors:**
| Factor | Type | Description |
|--------|------|-------------|
| Volume-Price Confirmation | Technical | Price up + volume up = healthy |
| Bearish Divergence | Technical | Price up + volume down = distribution risk |
| Bullish Divergence | Technical | Price flat + volume accumulating = opportunity |
| Volume Dry-Up→Spike | Technical | Accumulation completion signal |
| A-Share Mean Reversion | Market-Specific | Block extreme overbought in CN market |

**Result:** Committed. Surge score now 10 components, better at filtering false breakouts.

---

## Round 3 — Consecutive Bullish + Market-Specific Weights (2026-03-29)

**Changes:**
- Consecutive bullish momentum detector: 3-4 up days + volume → +5-15 bonus
- Market-specific composite weights (TW: 35% smart, CN: 30% surge)
- Enhanced Python hypothesizer with trailing stop mutations + weighted scoring toggle

**New Factors:**
| Factor | Type | Description |
|--------|------|-------------|
| Consecutive Bullish | Technical | 3+ consecutive up closes with vol increase |
| Market-Specific Weights | System | TW emphasizes smart money, CN emphasizes momentum |

**Result:** Committed. Strategy now adapts to market characteristics.

---

## Round 4 — Evaluator + Investment Trust + Strategy Log (2026-03-29)

**Changes:**
- Created `evaluator.py` with scoring formula implementation
- Added `score_chip_detailed()` for investment trust consecutive buying analysis
- Added strategy log tracking

**New Factors:**
| Factor | Type | Description |
|--------|------|-------------|
| Investment Trust Consecutive Buy | Chip | 投信連買 3-5+ days → +8-15 bonus |
| Foreign Investor Consecutive Buy | Chip | 外資連買 3-5+ days → +5-10 bonus |
| Chip Concentration | Chip | 三大法人同步買超 → +5 bonus |
| Strategy Score | System | AnnualReturn×0.4 + WinRate×0.3 - MDD×0.3 |

**Result:** Committed. Self-evaluation loop established.

---

## Round 5 — Sector Momentum + Retry Logic (2026-03-29)

**Changes:**
- Sector heat detection: multiple stocks from same industry passing = hot sector bonus (+5 to +20)
- Exponential backoff retry (3 attempts) for all data fetchers (AKShare, FinMind, yfinance)

**New Factors:**
| Factor | Type | Description |
|--------|------|-------------|
| Sector Heat | Sector Rotation | 2 stocks same sector: +5, 3: +10, 4: +15, 5+: +20 |
| Data Retry | Infrastructure | Exponential backoff prevents data gaps |

**Result:** Committed. Captures sector rotation themes.

---

## Round 6 — Retail Sentiment Contrarian + Northbound Flow + Trend Acceleration (2026-03-29)

**Changes:**
- Created `retailSentiment.ts`: proxy for margin trading (融資融券) sentiment
  - Chase-buy detection (FOMO after extended rally)
  - Panic selling detection (margin calls / forced liquidation)
  - Volume exhaustion (distribution phase)
- Created `trendAcceleration.ts`: MA slope acceleration, ROC acceleration, envelope width
- Northbound capital flow (`fetch_northbound_flow`, `score_northbound`) for A-shares
- Contrarian adjustments to composite score and adaptive exit params

**New Factors:**
| Factor | Type | Description |
|--------|------|-------------|
| Retail FOMO Chase | Contrarian | Gap-up + vol spike after extended rally → bearish |
| Panic Capitulation | Contrarian | Vol spike + big red candle near support → bullish |
| Volume Exhaustion | Contrarian | Price highs + declining volume = distribution |
| Trend Acceleration | Technical | MA slope rate of change, envelope width change |
| Northbound Flow | Chip (A-share) | 北向資金連續流入 = 外資看多 |

**Result:** Committed. System now has contrarian + macro flow factors.

---

## Round 7 — Earnings Surprise Detection (2026-03-29)

**Changes:**
- Enhanced `smartMoneyScore.ts` revenue momentum proxy: detects earnings surprise pattern
  (gap-up + high volume after tight consolidation = classic earnings catalyst reaction)
- Added `score_fundamental_detailed()` in Python: revenue surprise (YOY > 20%),
  revenue acceleration (YOY > 30%), high ROE grower detection, revenue decline warning
- Integrated detailed fundamental scoring into backtest engine

**New Factors:**
| Factor | Type | Description |
|--------|------|-------------|
| Earnings Surprise Pattern | Technical/Fundamental Proxy | Gap-up + vol spike after consolidation |
| Revenue YOY > 20% | Fundamental | 營收驚喜 → +10 score bonus |
| Revenue Acceleration > 30% | Fundamental | 營收加速成長 → +5 additional |
| High ROE Grower | Fundamental | ROE>15% + EPS>2 → +5 bonus |
| Revenue Decline Warning | Fundamental | YOY < -15% → -10 penalty |

**Result:** Committed. Fundamental factors now have graduated scoring with surprise detection.

---

## Round 8 — Portfolio Risk Management + Dynamic Position Sizing (2026-03-29)

**Changes:**
- Sector concentration limit: max 2 stocks per sector in capital-constrained backtest
- Dynamic position sizing: composite ≥75 → 1.3x, ≥60 → 1.1x, <40 → 0.7x allocation
- Prevents over-concentration in hot sectors while still allowing sector momentum bonus

**New Features:**
| Feature | Type | Description |
|---------|------|-------------|
| maxPerSector | Risk Mgmt | Limit per-sector exposure (default: 2) |
| Dynamic Sizing | Portfolio | Signal quality determines allocation size |
| Sector Diversification | Portfolio | Skip excess stocks from same sector |

**Result:** Committed. Portfolio now balances sector momentum with diversification.

---

## Round 9 — Support/Resistance Entry Quality (2026-03-29)

**Changes:**
- Created `supportResistance.ts`: analyzes swing high/low S/R levels, MA clusters,
  and breakout patterns to score entry quality
- Near support: +5-10 composite bonus (better risk/reward)
- Near resistance: -10 penalty (unless breaking out with volume → +15)
- Breakout above recent highs with volume: +10 bonus
- MA support cluster (2+ MAs converging below): +8 bonus

**New Factors:**
| Factor | Type | Description |
|--------|------|-------------|
| Swing S/R Proximity | Technical | Distance to nearest swing high/low levels |
| MA Support Cluster | Technical | Multiple MAs converging below price = strong floor |
| Resistance Breakout | Technical | Closing above swing highs with volume = continuation |
| MA Resistance | Technical | Multiple MAs above price = headwind penalty |

**Result:** Committed. Entry quality now considers support/resistance context.

---

## Round 10 — Volatility Regime Adaptive Parameters (2026-03-29)

**Changes:**
- Created `volatilityRegime.ts`: ATR percentile, Bollinger width, range ratio analysis
- 4 regimes: LOW (tight stops, long holds), NORMAL, HIGH (wide stops, short holds), EXTREME (half size)
- Integrated into BacktestEngine adaptive params: stop/hold/size all adjust by regime
- Added to scanner output for downstream use

**New Factors:**
| Factor | Type | Description |
|--------|------|-------------|
| ATR Percentile | Volatility | Current ATR rank vs 120-day history |
| BB Width | Volatility | Bollinger Band width compression/expansion |
| Range Ratio | Volatility | Recent 5d range vs prior 20d range |
| Vol Regime | System | Adaptive stops/holds/sizing by regime |

**Regime Adjustments:**
| Regime | Stop-Loss | Hold Days | Position Size |
|--------|-----------|-----------|---------------|
| LOW | ×0.75 (tighter) | ×1.2 (longer) | ×1.1 |
| NORMAL | ×1.0 | ×1.0 | ×1.0 |
| HIGH | ×1.25 (wider) | ×0.8 (shorter) | ×0.75 |
| EXTREME | ×1.5 (widest) | ×0.6 (shortest) | ×0.5 |

**Result:** Committed. Strategy now fully adapts to market volatility environment.

---

## Round 11 — Market Breadth Macro Filter (2026-03-29)

**Changes:**
- Created `marketBreadth.ts`: measures overall market health from scan pass rate
- 4 levels: STRONG (+5), MODERATE (0), WEAK (-5), VERY_WEAK (-10) composite adjust
- Applied after all individual scans to add macro context
- Uses pass rate % and uptrend participation % as health metrics

**New Factors:**
| Factor | Type | Description |
|--------|------|-------------|
| Scan Pass Rate | Macro | % of total stocks passing all filters |
| Uptrend Participation | Macro | % of passed stocks in 多頭 trend |
| Market Breadth Class | Macro | STRONG/MODERATE/WEAK/VERY_WEAK |

**Result:** Committed. System now adjusts confidence based on broad market health.

---

## Summary: 11 Rounds of Optimization

| Round | Focus | Key Addition |
|-------|-------|-------------|
| 1 | Multi-Factor Foundation | Smart money score, composite ranking |
| 2 | Volume-Price Analysis | Divergence detection, A-share mean reversion |
| 3 | Momentum Detection | Consecutive bullish, market-specific weights |
| 4 | Evaluation System | Scoring formula, investment trust factor |
| 5 | Sector Analysis | Sector heat momentum, data retry logic |
| 6 | Contrarian Signals | Retail sentiment, northbound flow, trend accel |
| 7 | Fundamentals | Earnings surprise, revenue acceleration |
| 8 | Risk Management | Sector limits, dynamic position sizing |
| 9 | Entry Quality | Support/resistance proximity |
| 10 | Volatility Adapt | Regime detection, adaptive stops/holds/sizing |
| 11 | Macro Context | Market breadth, broad participation filter |

## Round 12 — Calendar Seasonality (2026-03-29)

**Changes:**
- Month-end window dressing (投信作帳): +3 to +5 composite boost
- Quarter-end: stronger effect, first days of quarter: -3 penalty
- January effect, ex-dividend season, Friday effect, year-end rally
- Market-specific: TW Friday effect, CN National Day anticipation

---

## Round 13 — Cross-Timeframe Confirmation (2026-03-29)

**Changes:**
- Synthesize weekly candles from daily data (no extra API needed)
- Weekly trend alignment: MA10, MA direction, candle patterns, HH+HL
- STRONG alignment: +10 composite, CONFLICTING: -10
- Multi-timeframe confirmation = strongest edge multiplier

---

## Summary: 13 Rounds of Optimization

| Round | Focus | Key Addition |
|-------|-------|-------------|
| 1 | Multi-Factor Foundation | Smart money score, composite ranking |
| 2 | Volume-Price Analysis | Divergence detection, A-share mean reversion |
| 3 | Momentum Detection | Consecutive bullish, market-specific weights |
| 4 | Evaluation System | Scoring formula, investment trust factor |
| 5 | Sector Analysis | Sector heat momentum, data retry logic |
| 6 | Contrarian Signals | Retail sentiment, northbound flow, trend accel |
| 7 | Fundamentals | Earnings surprise, revenue acceleration |
| 8 | Risk Management | Sector limits, dynamic position sizing |
| 9 | Entry Quality | Support/resistance proximity |
| 10 | Volatility Adapt | Regime detection, adaptive stops/holds/sizing |
| 11 | Macro Context | Market breadth, broad participation filter |
| 12 | Timing | Calendar seasonality (月底作帳, quarter effects) |
| 13 | Multi-Timeframe | Weekly trend confirmation from daily data |

### Total New Analysis Modules Created:
1. `smartMoneyScore.ts` — Institutional flow proxy (OBV, CLV, gaps)
2. `retailSentiment.ts` — Margin trading contrarian signals
3. `trendAcceleration.ts` — MA slope acceleration
4. `supportResistance.ts` — S/R proximity + breakout detection
5. `volatilityRegime.ts` — ATR percentile regime classification
6. `marketBreadth.ts` — Broad market health from scan results
7. `seasonality.ts` — Calendar effects (月底作帳, quarter-end)
8. `crossTimeframe.ts` — Weekly trend synthesis + alignment

## Round 14 — Python Engine ATR/OBV Enhancement (2026-03-29)
- ATR14, OBV, OBV_MA20, ATR percentile, MA50 added to Python technical module
- New condition types: obv_trend, low_volatility_breakout, weekly_trend_confirm, rsi_neutral_zone
- Volatility regime adjustment in Python backtest engine

## Round 15 — v002 Multi-Factor Strategy (2026-03-29)
- 9-condition strategy (6 original + OBV, weekly, RSI) with min_conditions=5
- Relaxed thresholds, enabled weighted scoring mode

## Round 16 — Smarter Optimizer Mutations (2026-03-29)
- add_condition and swap_condition mutation types
- OBV, weekly, RSI, low-vol breakout as addable conditions

## Round 17 — Advanced Risk Metrics (2026-03-29)
- Sortino ratio, Calmar ratio, recovery factor, max consecutive wins
- Enhanced evaluator: 35/25/25/15 weighting + risk bonus up to +1.5

---

## Summary: 17 Rounds of Optimization

| Round | Focus | Key Addition |
|-------|-------|-------------|
| 1 | Multi-Factor Foundation | Smart money score, composite ranking |
| 2 | Volume-Price Analysis | Divergence detection, A-share mean reversion |
| 3 | Momentum Detection | Consecutive bullish, market-specific weights |
| 4 | Evaluation System | Scoring formula, investment trust factor |
| 5 | Sector Analysis | Sector heat momentum, data retry logic |
| 6 | Contrarian Signals | Retail sentiment, northbound flow, trend accel |
| 7 | Fundamentals | Earnings surprise, revenue acceleration |
| 8 | Risk Management | Sector limits, dynamic position sizing |
| 9 | Entry Quality | Support/resistance proximity |
| 10 | Volatility Adapt | Regime detection, adaptive stops/holds/sizing |
| 11 | Macro Context | Market breadth, broad participation filter |
| 12 | Timing | Calendar seasonality (月底作帳, quarter effects) |
| 13 | Multi-Timeframe | Weekly trend confirmation from daily data |
| 14 | Python Engine | ATR/OBV/MA50, vol regime in Python backtest |
| 15 | Strategy v002 | 9-condition multi-factor strategy |
| 16 | Optimizer | Add/swap condition mutations |
| 17 | Risk Metrics | Sortino/Calmar/recovery + enhanced evaluator |

### Analysis Modules (TypeScript):
1. `smartMoneyScore.ts` — Institutional flow proxy (OBV, CLV, gaps)
2. `retailSentiment.ts` — Margin trading contrarian signals
3. `trendAcceleration.ts` — MA slope acceleration
4. `supportResistance.ts` — S/R proximity + breakout detection
5. `volatilityRegime.ts` — ATR percentile regime classification
6. `marketBreadth.ts` — Broad market health from scan results
7. `seasonality.ts` — Calendar effects (月底作帳, quarter-end)
8. `crossTimeframe.ts` — Weekly trend synthesis + alignment

### Python Engine Enhancements:
- `analysis/technical.py`: ATR14, OBV, ATR percentile, MA50
- `analysis/chip.py`: Northbound flow, detailed chip scoring
- `analysis/fundamental.py`: Detailed fundamental + earnings surprise
- `backtest/engine.py`: Volatility regime + multi-factor adaptive params
- `backtest/metrics.py`: Sortino, Calmar, recovery factor
- `evaluator.py`: Enhanced scoring with risk adjustment bonus
- `strategies/v002.py`: 9-condition multi-factor strategy

## Pending Improvements

- [ ] Machine learning signal combination (gradient boosting on all factors)
- [ ] Cross-market correlation (when TW semi leads, CN semi follows)
- [ ] Kelly criterion position sizing based on historical win rate
- [ ] Intraday VWAP-based entry optimization
