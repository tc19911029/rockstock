# 朱家泓線上課 CH3 — 均線

> **完整逐字筆記**：`/Users/tc/Desktop/朱家泓課程/筆記/CH3-均線/`（6 小節 + 章節總覽）
> **講師**：朱家泓本人
> **rockstock 端用途**：固化 Tier 1 #1（MA20 斜率排序）+ Tier 1 #3（接近壓力區）的線上課依據。本章兩條 Tier 1 同時源於此章 — 均線方向 / 角度 / 葛蘭碧法則。

---

## 全章地圖（6 節）

| # | 課題 | 一句話重點 | 完整筆記 |
|---|---|---|---|
| 3-1 | 均線的基本概念 | 均線本質 = 成本理論；長均線轉向慢、力道強 | [01-...md](../../../朱家泓課程/筆記/CH3-均線/01-均線的基本概念.md) |
| 3-2 | 移動扣抵 | 「扣抵新進舊出」可未卜先知均線何時轉向 | [02-...md](../../../朱家泓課程/筆記/CH3-均線/02-移動扣抵.md) |
| 3-3 | 均線三大力量 | 向上：支撐 / 助漲 / 減弱下跌；向下：壓力 / 助跌 / 減弱反彈 | [03-...md](../../../朱家泓課程/筆記/CH3-均線/03-均線三大力量.md) |
| 3-4 | 多頭排列與空頭排列 | 短上長下依序 = 多頭排列；三線多排可短多、四線多排可長多 | [04-...md](../../../朱家泓課程/筆記/CH3-均線/04-多頭排列與空頭排列.md) |
| 3-5 | 黃金交叉、死亡交叉與均線糾結 | 短穿長 = 黃金交叉、糾結後突破是大行情 | [05-...md](../../../朱家泓課程/筆記/CH3-均線/05-黃金交叉、死亡交叉與均線糾結.md) |
| 3-6 | 葛蘭碧 8 大法則 | 走勢 + 20MA 構成 4 買 4 賣，第 4 條是逆勢交易要警覺 | [06-...md](../../../朱家泓課程/筆記/CH3-均線/06-葛蘭碧8大法則.md) |

---

## Tier 1 #1 對應 — 「MA20 斜率排序」

### 課程依據（3-3「均線三大力量」原文）

> **三大力量的強度因素**：
>   - **均線越長 → 三大功能越強**（5MA 最弱，60MA、120MA 越強）
>   - **角度越陡 → 三大功能越強**（強勢股 20MA 角度很陡，回檔到月線就反彈）
>   - **角度越大 → 越不容易彎**（用扣抵推：強股每天扣的價格越低，要轉向越難）
>
> **找強勢股就找 20MA 角度陡的 — 角度越大力量越強**。

### rockstock 實作對應

| 概念 | rockstock 實作 | 狀態 |
|---|---|---|
| MA20 斜率計算 | [lib/rules/ruleUtils.ts](../lib/rules/ruleUtils.ts) `ma20Slope(candles, idx, lookback=5)` % change 量化 | ✅ |
| MA20 斜率納入 StockScanResult | [lib/scanner/types.ts:570](../lib/scanner/types.ts) `ma20Slope?: number` | ✅ |
| 排序第三鍵（多頭時）| [lib/selection/applyPanelFilter.ts:51-65](../lib/selection/applyPanelFilter.ts#L51) `panelSortCompare` | ✅ |
| backtest 對齊 | [lib/selection/applyPanelFilter.ts:73-80](../lib/selection/applyPanelFilter.ts#L73) `panelSortKey` | ✅ |
| UI ScanResults sort 共用 | [features/scan/components/ScanResultsTable.tsx](../features/scan/components/ScanResultsTable.tsx) + Compact | ✅ |

**設計取捨**：只在「雙方都是多頭」時才啟用第三鍵，避免初轉多股票因 MA20 還沒翻揚被誤排（commit 669f273 設計選擇）。

---

## Tier 1 #3 對應 — 「接近壓力區」

### 課程依據（3-6「葛蘭碧 8 大法則」+ 3-3）

葛蘭碧賣點 6 + 賣點 7 的核心是「股價反彈到下彎均線受壓回跌」，課程明白說：

> 反彈到均線容易止漲再跌（壓力）
> 突破均線但均線仍下彎 → 把股價拉回均線下方繼續跌（助跌）

對應「多頭高檔接近壓力區」的概念，朱老師用「預壓有壓」描述（CH2-9 第 3 點）：

> **預壓有壓**：盤中觸壓但留長上影 + 收盤拉回 → 空方力道介入 → 次日不可跌，跌就確認壓力

### rockstock 實作對應

| 概念 | rockstock 實作 | 狀態 |
|---|---|---|
| `TrendPosition` 加「接近壓力區」 | [lib/analysis/trendAnalysis.ts:498](../lib/analysis/trendAnalysis.ts#L498) `NEAR_SR_PCT = 0.03`（3% 經驗值）| ✅ |
| `detectTrendPosition` 判定 | [lib/analysis/trendAnalysis.ts:513-516](../lib/analysis/trendAnalysis.ts#L513) — 多頭時收盤逼近近 60 根 swing high 3% 內 → 標 `'接近壓力區'` | ✅ |
| 空頭對稱版（接近支撐區）| 同檔（找近 60 根 swing low 3% 內）| ✅ |
| 葛蘭碧 8 法則 detector | [lib/rules/granvilleRules.ts](../lib/rules/granvilleRules.ts) | ✅（完整 8 條）|

**3% 距離為實作具體化**：書本只說「接近壓力」未量化，3% 是 commit 669f273 的工程選擇。

---

## 本章核心戒律

1. **均線方向 = 操作方向**：均線向上只做多，向下只做空。
2. **三線多排是短多最低門檻**：MA5 > MA10 > MA20 + 全部向上。少一條都不行。
3. **四線多排可長多**：MA5 > MA10 > MA20 > MA60，季線（60MA）助漲 = 長線安全墊。
4. **均線扣抵預判**：對著明天要進的價格 vs 要扣掉的價格 → 預知均線翻揚 / 翻空時點。
5. **黃金交叉/死亡交叉要配合趨勢**：盤整中的交叉常假訊號，配合多頭/空頭排列才真。
6. **均線糾結後的突破 = 大行情**：但要等真突破，不要預測方向。
7. **葛蘭碧第 4 法則是地雷**：乖離過大反彈/回測是逆勢交易，散戶最容易在這裡賠錢。

---

## 葛蘭碧 8 大法則 → rockstock 字母對應

| # | 訊號 | 方向 | rockstock 字母 |
|---|---|---|---|
| 1 | 均線翻揚突破 | **買** | B / C 系 |
| 2 | 拉回不破均線 | **買** | K / L 系（回後買上漲）|
| 3 | 跌破均線快速拉回 | **買** | M / P 系 |
| 4 | 乖離過大反彈（逆勢）| **買** | D / F 系（反轉軌）|
| 5 | 均線翻彎跌破 | **賣** | 出場規則 |
| 6 | 反彈未過均線 | **賣** | 出場規則 |
| 7 | 突破均線快速跌回 | **賣** | 出場規則 |
| 8 | 乖離過大反彈賣出（逆勢）| **賣** | 系統戰法 Q |

---

## 完整 rockstock 索引

- MA 計算：[lib/indicators.ts](../lib/indicators.ts) MA5/10/20/60
- 移動扣抵：[lib/analysis/maPivot.ts](../lib/analysis/maPivot.ts)
- 多/空頭排列：[lib/analysis/trendAnalysis.ts](../lib/analysis/trendAnalysis.ts)
- 黃金/死亡交叉：[lib/rules/granvilleRules.ts](../lib/rules/granvilleRules.ts)
- 葛蘭碧 8 法則：[lib/rules/granvilleRules.ts](../lib/rules/granvilleRules.ts)
- 買法軌字母對應：[lib/scanner/buyMethodTracks.ts](../lib/scanner/buyMethodTracks.ts)
- 月線/季線過濾：[lib/selection/applyPanelFilter.ts](../lib/selection/applyPanelFilter.ts) 六條件
