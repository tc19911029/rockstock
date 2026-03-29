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

## Pending Improvements

- [ ] Investment trust consecutive buying (投信連買) factor for Taiwan
- [ ] Northbound flow (北向資金) factor for A-shares
- [ ] Margin trading (融資融券) contrarian signal
- [ ] Sector rotation detection
- [ ] Earnings surprise momentum
