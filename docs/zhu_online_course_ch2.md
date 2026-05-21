# 朱家泓線上課 CH2 — K 線

> **完整逐字筆記**：`/Users/tc/Desktop/朱家泓課程/筆記/CH2-K線/`（9 小節 + 章節總覽）
> **講師**：林穎（朱家泓大徒弟；Whisper 易誤聽為「凌穎」，正確寫法是「林穎」）
> **rockstock 端用途**：固化 Tier 1 #2「弱中透強加持」的線上課依據。

---

## 全章地圖（9 節）

| # | 課題 | 一句話重點 | 完整筆記 |
|---|---|---|---|
| 2-1 | K 線起源與基本概念 | 本間宗久 17 世紀發明，紅/黑 K 看當日多空，但顏色 ≠ 漲跌 | [01-...md](../../../朱家泓課程/筆記/CH2-K線/01-K線起源與基本概念.md) |
| 2-2 | K 線本身的支撐壓力與強弱的改變 | 昨日最高 = 今日壓力、昨日最低 = 今日支撐；收盤過/破才算 | [02-...md](../../../朱家泓課程/筆記/CH2-K線/02-K線本身的支撐壓力與強弱的改變.md) |
| 2-3 | K 線橫盤的原則與進出場 | ≥3 根沒破彼此 = 橫盤；紅 K 過上頸線 = 多買、黑 K 破下頸線 = 空進 | [03-...md](../../../朱家泓課程/筆記/CH2-K線/03-K線橫盤的原則與進出場的確認.md) |
| 2-4 | 實體長紅棒 | 實體 ≥ 6.5% = 長紅；位置決定意義（底進貨/行進續攻/高出貨）| [04-...md](../../../朱家泓課程/筆記/CH2-K線/04-實體長紅棒.md) |
| 2-5 | 實體長黑棒 | 跟長紅對稱；高檔長黑 = 出貨、低檔長黑爆量 = 止跌訊號 | [05-...md](../../../朱家泓課程/筆記/CH2-K線/05-實體長黑棒.md) |
| 2-6 | 高檔變盤線 | 8 組單根 + 6 組「左藏紅右藏黑」紅黑配，看次日確認反轉 | [06-...md](../../../朱家泓課程/筆記/CH2-K線/06-高檔變盤線.md) |
| 2-7 | 低檔變盤線 | 對稱版：8 組單根 + 6 組「左長黑右長紅」黑紅配 | [07-...md](../../../朱家泓課程/筆記/CH2-K線/07-低檔變盤線.md) |
| 2-8 | 三根 K 棒組合 | 夜星（高檔紅+變+黑）/ 晨星（低檔黑+變+紅）= 進階轉折 | [08-...md](../../../朱家泓課程/筆記/CH2-K線/08-三根K棒組合.md) |
| 2-9 | K 線 4 元素與 1/2 價 | 開盤=主力企圖、收盤=當日勝負、1/2 價=平均成本 | [09-...md](../../../朱家泓課程/筆記/CH2-K線/09-K線4元素的進階意義與1比2價的應用.md) |

---

## Tier 1 #2 對應 — 「弱中透強 / 強中透弱」加持

### 課程定義（橫跨 2-1 / 2-2 / 2-9）

朱家泓 / 林穎在課程中反覆強調：

- **K 線顏色 ≠ 漲跌**：紅 K（close > open）可能整體還是跌（close < 昨日 close）；黑 K 可能還是漲。
- **「弱中透強」**：當日表面看似弱勢（紅 K 但相對昨日是跌），實際盤中多方已在出手 → 出現在**低檔**是止跌徵兆。
- **「強中透弱」**：當日表面看似強勢（黑 K 但相對昨日是漲），實際盤中空方已開始出貨 → 出現在**高檔**是止漲警訊。

### rockstock 實作對應

| 概念 | rockstock 實作 | 來源 |
|---|---|---|
| 弱中透強純形態 | [ruleUtils.ts:292](../lib/rules/ruleUtils.ts#L292) `isStrongInWeakness` | 朱老師 CH2 |
| 強中透弱純形態 | [ruleUtils.ts:300](../lib/rules/ruleUtils.ts#L300) `isWeakInStrength` | 朱老師 CH2 |
| 低檔弱中透強（位置條件版）| [ruleUtils.ts:308](../lib/rules/ruleUtils.ts#L308) `isStrongInWeaknessAtBottom` | 同上 + 位置 |
| 高檔強中透弱（位置條件版）| [ruleUtils.ts:321](../lib/rules/ruleUtils.ts#L321) `isWeakInStrengthAtTop` | 同上 + 位置 |
| D/F 反轉軌觸發時近 5 根近檔加持 | [MarketScanner.ts:1404-1410](../lib/scanner/MarketScanner.ts#L1404) | Tier 1 #2 |
| 高檔強中透弱出場警示 | [smartKLineRules.ts:88](../lib/rules/smartKLineRules.ts#L88) `topExhaustionWarning` | Tier 1 #2 |

**書本依據**：CH2-K線/02「K 線本身的支撐壓力與強弱的改變」第 2-3 點直接定義「收盤穿越前一日 K 棒高/低點為轉強/轉弱」；CH2-9「K 線 4 元素」第 2 點補完「收盤價是當日勝負」原則。

---

## 本章核心戒律

1. **顏色 ≠ 漲跌**：紅 K 可能跌（弱中透強），黑 K 可能漲（強中透弱）。判斷要跟昨日收盤比。
2. **收盤決定一切**：突破、跌破、過頸線、破支撐 — 都看收盤，不看盤中影線。
3. **位置決定意義**：同樣一根長紅，底部=進貨、行進=續攻、高檔=出貨；長黑反之。
4. **次日確認**：所有變盤線（單根、雙根、三根組合）都不是當下定論，要看**次日開盤方向**確認反轉。
5. **長紅三層支撐 / 長黑三層壓力**：最強 → 1/2 價 → 最弱 → 全失守 = 多空易位。
6. **空頭低檔 + 爆量長黑 = 早期止跌訊號**：不必等紅 K，學過的人就知道空單該停利。

---

## K 棒類型分級（書本明確）

| 類型 | 實體棒（紅/黑通用）|
|---|---|
| 長棒 | ≥ 6.5% |
| 中棒 | 3.5% ~ 6.5% |
| 小棒 | < 3.5% |
| 十字 / 變盤線 | < 0.5% |

⚠️ **rockstock 偏離**：[ruleUtils.ts](../lib/rules/ruleUtils.ts) 的 `isLongRedCandle()` 用 2% 為門檻，比書本「長棒 ≥ 6.5%」寬鬆許多。詳見主審計第二類 A1/A2。整體偏保守取向（命中率高、單根強度低）。

---

## 完整書本對應索引（細項 detector）

| 概念 | rockstock 實作 |
|---|---|
| 三根 K 棒組合（夜星/晨星）| [lib/rules/threeBarReversalRules.ts](../lib/rules/threeBarReversalRules.ts) |
| 橫盤突破 | [lib/analysis/klineConsolidationBreakout.ts](../lib/analysis/klineConsolidationBreakout.ts) |
| 底部反轉組合（長紅吞噬等）| [lib/rules/bottomFormationRules.ts](../lib/rules/bottomFormationRules.ts) |
| 量價背離 | [lib/analysis/chipDivergence.ts](../lib/analysis/chipDivergence.ts) |
| 1/2 價 | [lib/rules/ruleUtils.ts:18](../lib/rules/ruleUtils.ts#L18) `halfPrice()` |
| 反轉軌（D/F/N/O）| [lib/scanner/buyMethodTracks.ts:62](../lib/scanner/buyMethodTracks.ts#L62) |
