# 策略知識來源審計報告（Knowledge Contamination Audit）

**審計日期**：2026-05-22（CST）
**修訂**：2026-05-22 同日二次審計 — Q 三均線戰法從《抓住線圖股民變股神》p.262 OCR 確認對齊書本，從第四類（資料不足）移入第一類（書本明確），原 PDF 衝突項解除。
**審計範圍**：rockstock 全部策略規則
**審計方法**：
1. 三輪 Explore agent 盤點 code 規則位置
2. 主 context 讀 [lib/analysis/bookThresholds.ts](../../lib/analysis/bookThresholds.ts) + [docs/STRATEGY_BOOK_REFERENCE.md](../STRATEGY_BOOK_REFERENCE.md)
3. Sub-agent 萃取朱家泓免費體驗課 PDF（73 頁）原文要點
4. Sub-agent 建立 220+ 條規則完整總表
5. git log 比對 docs/STRATEGY_BOOK_REFERENCE.md（2026-04-21 後停更）與 lib/ 之後 commit
6. 主 context 交叉比對、分類、寫報告

**這份報告不修改任何 lib/ code**。這是純審計輸出，後續行動由使用者裁決。

---

## Executive Summary

### 總計

- **規則總數**：約 220 條（涵蓋六條件、戒律、淘汰法、字母策略、停損停利、排序因子、顯示色階、門檻常數）
- **五類分佈**：
  - 第一類 ✅ 書本明確：約 132 條（60%）
  - 第二類 ⚠️ 來源模糊：約 25 條（11%）
  - 第三類 ❌ 自創/AI 補：約 35 條（16%）
  - 第四類 📭 資料不足：約 13 條（6%）
  - 第五類 🔄 已偏離書本：約 15 條（7%）

### 整體健康度

| 項目 | 狀態 |
|------|------|
| 六條件、戒律、淘汰法核心 | ✅ **書本對齊度高**，主要規則都有頁碼出處 |
| 高勝率 6 位置 | ✅ **完整對齊** 寶典 Part 12 p.749-755 |
| B/C/D/E/F/J/K/L/M/N/O/P 字母策略 | ⚠️ **大致對齊書本，但 docs 未追上 code** |
| Q 三均線戰法（MA3/10/24） | ✅ **已對齊書本** — 2026-05-22 二次審計確認《抓住線圖股民變股神》p.262 原文：三均線 = MA3/10/24，進場 / 出場 / 停損條件全部命中（PDF p37「第三大金剛 MA5/10/20/60」是不同戰法，不衝突） |
| R 乖離率機械軌 | ❌ **完全自創** — 無任何書本依據（2026-05-21 用戶要求新增） |
| Tier 1 三項對齊（MA20 斜率 / 弱中透強 / 接近壓力區） | 📭 **線上課程依據**，未經書本筆記固化 |
| 停損 7% / 停利 10% | ✅ 書本明確 |
| 乖離率上限 | 🔄 **已偏離**（書本 15% → 2026-05-19 手動放寬到 25%） |
| 淘汰法執行方式 | ✅ **已修復**（2026-05-22 回滾為 hard gate，對齊書本「立即出場」；TW 池子縮小 12.3%、CN 縮小 5.1%，見 [影響量測](./2026-05-22-elimination-hard-gate-impact.md)） |
| 籌碼背離 `chipDivergence.ts` | ❌ **整支檔案無書本標記** |
| 文件追上度（docs/STRATEGY_BOOK_REFERENCE.md） | ⚠️ **嚴重 stale**：2026-04-21 後 17+ 個策略 commit 未進文件 |

### TOP 5 最危險的污染點

| # | 規則 | 污染類型 | 位置 | 影響 |
|---|------|---------|------|------|
| 1 | ~~HIGH_DEVIATION_PCT = 0.25~~ → ✅ **已修復** | 🔄 偏離書本 → 已修復 | [bookThresholds.ts:142](../../lib/analysis/bookThresholds.ts#L142) | **2026-05-22 回滾到 0.15 對齊書本 p.568**。v12 cron 生產線零影響；SIXCOND 冠軍勝率 +8.5pp、報酬 −30% 但風險可控。詳見 [A/B 回測報告](./2026-05-22-high-deviation-pct-rollback-backtest.md)（commit `995c3a9`） |
| 2 | ~~淘汰法改警示不擋~~ → ✅ **已修復** | 🔄 偏離書本 → 已修復 | [MarketScanner.ts:494](../../lib/scanner/MarketScanner.ts#L494) | **2026-05-22 回滾為 hard gate**。實測 TW 池子 -12.3%、CN -5.1%，影響可控。詳見 [影響量測](./2026-05-22-elimination-hard-gate-impact.md) |
| 3 | ~~R 軌（乖離率排名）~~ → ⏸ **已暫停自動掃描** | ❌ 完全自創 → 暫停 | [buyMethodTracks.ts:74](../../lib/scanner/buyMethodTracks.ts#L74) | **2026-05-22 移除 vercel.json TW/CN mechanical cron**，code 保留以利回測；恢復 = 加回 2 條 cron（commit `d422cb0`） |
| 4 | **chipDivergence.ts 整支無書本** | ❌ 完全自創 | [chipDivergence.ts](../../lib/analysis/chipDivergence.ts) | 5% 漲跌 + 法人累積 500 張的門檻完全無註解，書本無對應 |
| 5 | **Tier 1 三項對齊（MA20 斜率 / 弱中透強 / 接近壓力區）** | 📭 線上課依據 | [applyPanelFilter.ts](../../lib/selection/applyPanelFilter.ts), [MarketScanner.ts:1400](../../lib/scanner/MarketScanner.ts#L1400), [trendAnalysis.ts:498](../../lib/analysis/trendAnalysis.ts#L498) | 朱老師 CH3 / 林穎 CH2 線上課，無書本頁碼；commit 669f273 混用「書本/線上課程」字眼 |

### 建議首要行動（按急迫性）

1. ~~立即決定：HIGH_DEVIATION_PCT 25% / 15%？~~ → **2026-05-22 完成**：回滾到 15% 對齊書本 p.568（commit `995c3a9`）；連動戒律 3 / 做空戒律 3 / Step 5 ② 切 MA5 / BASE_THRESHOLDS / ZHU_PURE_BOOK / B/P 進階紀律 override。
2. ~~立即決定：淘汰法「警示不擋」要保留還是回到書本「立即出場」？~~ → **2026-05-22 完成**：回滾為 hard gate；TW 池子縮小 12.3%、CN 縮小 5.1%，仍剩 161/230 檔可選，無 pool 飢餓風險（commit `e44b7fc`）。
3. ~~暫停評估：R 軌（機械乖離率排名）~~ → **2026-05-22 完成**：移除 vercel.json TW/CN mechanical cron，code 保留以利回測，重啟 = 加回 2 條 cron（commit `d422cb0`）。
4. ~~資料補齊：Q 三均線戰法書本頁碼確認~~ → **2026-05-22 完成**：經查《抓住線圖股民變股神》p.262 原文，Q 戰法 MA3/10/24 與進場/出場/停損條件全部對齊書本。
5. **文件補齊**：更新 STRATEGY_BOOK_REFERENCE.md 涵蓋 2026-04-21 後加入的 17+ 個 commit 改動。

---

## 五類規則詳述

### 第一類 ✅ 書本明確（可繼續使用）

這些規則 code 註解明確標頁碼，與書本/docs 對照一致。**約 130 條**，逐條列舉沒有意義，按主題歸納：

#### 1.1 六條件（A 策略核心）— 全部對齊寶典 p.54
| 規則 | code | 書本 |
|------|------|------|
| ① 趨勢多頭 = 頭頭高底底高 | [trendAnalysis.ts:568](../../lib/analysis/trendAnalysis.ts#L568) | 寶典 p.54 ① + p.35 |
| ② MA5>MA10>MA20 + MA10/20 上揚 | [trendAnalysis.ts:725](../../lib/analysis/trendAnalysis.ts#L725) | 寶典 p.54 ② |
| ③ close > MA10 且 > MA20 | [trendAnalysis.ts:590](../../lib/analysis/trendAnalysis.ts#L590) | 寶典 p.54 ③ |
| ④ 攻擊量 ≥ 前日 × 1.3 | [BOOK_VOL_RATIO_MIN](../../lib/analysis/bookThresholds.ts#L22) | 寶典 p.54 ④ |
| ⑤ 紅K實體 ≥ 2% + 高收盤 + 上影 ≤ 實體 | [BOOK_BODY_PCT_MIN](../../lib/analysis/bookThresholds.ts#L19) + [trendAnalysis.ts:693](../../lib/analysis/trendAnalysis.ts#L693) | 寶典 p.54 ⑤ |
| ⑥ MACD 綠縮/紅延 OR KD 金叉 | [trendAnalysis.ts:797](../../lib/analysis/trendAnalysis.ts#L797) + [v12Conditions.ts:47](../../lib/analysis/v12Conditions.ts#L47) | 寶典 p.55 ⑥ |
| isCoreReady = 前 5 必過 | [trendAnalysis.ts:845](../../lib/analysis/trendAnalysis.ts#L845) | 寶典 p.54「1-5 必要」 |

#### 1.2 十大戒律 — 對齊寶典 p.57-58
| 戒律 | code | 狀態 |
|------|------|------|
| 戒 1 未突破月線 | 併入六條件 ③ | ✅ |
| 戒 2 連 3 紅K | [entryProhibitions.ts:79](../../lib/rules/entryProhibitions.ts#L79) | ✅ |
| 戒 3 量價背離 + KD 高 + 乖離（3 項合一） | [entryProhibitions.ts:96](../../lib/rules/entryProhibitions.ts#L96) | ✅（2026-05-22 乖離回滾到書本 15%，commit `995c3a9`） |
| 戒 4 週線壓力 | [entryProhibitions.ts:122](../../lib/rules/entryProhibitions.ts#L122) | ✅（3% 距離為實作具體化，第二類） |
| 戒 5 未站月線 | 併入六條件 ③ | ✅（已 dedupe） |
| 戒 6 底底低 | [entryProhibitions.ts:132](../../lib/rules/entryProhibitions.ts#L132) | ✅ |
| 戒 7 盤整 | [entryProhibitions.ts:145](../../lib/rules/entryProhibitions.ts#L145) | ✅ |
| 戒 8 空頭紅K反彈 | [entryProhibitions.ts:67](../../lib/rules/entryProhibitions.ts#L67) | ✅ |
| 戒 9 連 3 爆量長紅 | [entryProhibitions.ts:166](../../lib/rules/entryProhibitions.ts#L166) | ✅（爆量 ×2 對齊《抓住飆股》） |
| 戒 10 黑K | 併入六條件 ⑤ | ✅ |
| ~~戒 11 上升切線~~ | — | ✅ 已移除（2026-04-20） |

#### 1.3 淘汰法 R1-R11 — 對齊寶典 Part 10 p.659-662
- ✅ R1/R2/R5/R6/R7/R9 完整實作
- ✅ R3/R8/R10/R11 已移除（書本概念過寬或基本面超出範圍）
- 🔄 **執行方式偏離**：2026-05-20 改為「警示不擋」（見第五類）

#### 1.4 高勝率 6 位置（A 策略加分）— 全部對齊寶典 Part 12 p.749-755
- pos 1 多頭打底 → 寶典 p.749 ✅
- pos 2 不破前低 → 寶典 p.749 + p.37 ① ✅
- pos 3 突上頸線 → 寶典 p.750 ✅
- pos 4 糾結突破 → 寶典 p.751 ✅（糾結 3% 為第二類）
- pos 5 強勢回檔 → 寶典 p.752 圖 12-1-6 ✅
- pos 6 假跌破真上漲 → 寶典 p.753 圖 12-1-7 ✅

#### 1.5 字母策略 B/C/D/E/F/J/K/L/M/N/O/P — 大致對齊書本
- B 盤整突破 + 回後買上漲 → 5 步驟 p.40 + 寶典 p.238-244 ✅
- C V 反轉（在 buyMethodTracks 對應）→ 寶典 Part 12 祕笈圖 #1 + 抓住K線第 7 篇 ✅
- D 一字底 → 抓住飆股 25 型態 #9 ✅（**60% 量縮、8% 窄幅為第三類**）
- E 缺口 → 5 步驟 p.40 位置 4 ✅
- F V 反轉 → 寶典 Part 12 祕笈圖 #1 ✅
- J ABC 突破（原 G） → 寶典 Part 11-1 位置 6 p.697 ✅
- K K線橫盤（原 I） → 寶典 Part 11-1 位置 3 p.694 ✅
- L 大量黑K（原 H） → 寶典 Part 11-1 位置 8 p.699 ✅
- M 軌道線突破 → 寶典 Part 5 p.387 ✅
- N 25 型態 → 寶典 Part 11-1 位置 7 + 抓飆股 ✅（**padding 為第三類**）
- O 打底完成 → 寶典 Part 11-1 位置 1 p.691 ✅
- P 高檔淺回 → 寶典 Part 11-1 位置 3「等拉回」 ✅

#### 1.6 停損停利
- STOP_LOSS_RULE_PCT = 0.07 → 短線守則 p.41 ✅
- PROFIT_TARGET_RULE_PCT = 0.10 → 同上 ✅
- F 停損 ×7% → 書本明寫上限 ✅
- Q 守 MA10 → 抓住線圖 p.262 ✅
- Q 三均線戰法（MA3 金叉 MA10 + close > MA24 + MA24 上揚 + close > MA3） → 抓住線圖 p.262 原文 ✅（2026-05-22 確認，[v12LetterQ.ts](../../lib/analysis/v12LetterQ.ts)）
- ⑥-1/-2/-4/-5 強制出場（破盤整下緣 / 趨勢翻空 / 虧 10% / 結構破） → 寶典 Part 11-1 p.701 ✅
- SELL-tp-pattern-target → 5 步驟步驟 5 ✅
- SELL-tp-3red-shadow（連 3 紅 + 長上影） → 寶典 K 棒訊號 #7 ✅
- SELL-tp-high-vol-black-20（獲利 20% 後黑K大量跌破前低） → 寶典 #8 急漲反轉 ✅

#### 1.7 布林、切線、支撐阻力、指標型態
- 布林 8 大買賣訊（① 至 ⑧） → 寶典 p.574-575 ✅
- 布林開口、3 軌同向 → 寶典 p.577-581 ✅
- 切線斜率、觸碰次數、軌道突破 → 寶典 Part 5 p.348-393 ✅
- 黃金切割 0.236/0.382/0.5/0.618/0.809 → 寶典 p.472 ✅
- W 底/M 頭目標價公式 → 寶典 p.475-479 ✅
- 整數關卡 ×5/×10/×100 → 寶典 p.480-481 ✅
- 紅K 強/中/弱支撐（high/mid/low） → 寶典 p.462 ✅
- MACD 7 種型態（紅縮、紅長、背離、紅轉綠...） → 寶典 p.540-547 ✅
- KD 高/低檔鈍化、峰背離 → 寶典 p.553-558 ✅
- 趨勢警示（一日反轉、空頭反轉確認、布林、缺口竭盡、3 日 2 缺口、島型反轉） → 寶典 p.74-76, 575, 581, 593, 602, 607, 635, 638 ✅

#### 1.8 趨勢判定 + 末升段
- detectTrend → 寶典 p.35 ✅
- 末升段訊號 1：連 3 根「實體≥2% 紅K + vol≥前日×1.3」→ 書本 p.46 ✅
- 末升段訊號 2：vol≥前日×3 + 長黑K → 書本 p.50 ✅
- 末升段訊號 3：爆量不漲（兩天前 ≥ 今 close） → 書本 p.52 ✅

---

### 第二類 ⚠️ 來源模糊（書本有概念，實作具體化）

書本只有定性詞（「狹幅」「糾結」「大量」「接近壓力」），實作給了具體數字。**約 25 條**。

| rule_id | 規則 | code | 書本 | 實作具體化 |
|---------|------|------|------|------------|
| MA-cluster-spread | 三線聚合 spread < 3% | [bookThresholds.ts:90](../../lib/analysis/bookThresholds.ts#L90) | 寶典 Part 4「均線糾結」未量化 | 自選 3%（已標 JSDoc） |
| CONSOL-max-tight | 盤整狹幅 < 15% | [bookThresholds.ts:92](../../lib/analysis/bookThresholds.ts#L92) | 寶典 Part 4 p.299「狹幅 5-6 天」 | 自選 15% |
| HW-ma-cluster | 高勝率位置 4 糾結閾值 3% | [highWinRateEntry.ts:86](../../lib/analysis/highWinRateEntry.ts#L86) | 同上 | 3% |
| PROHIB-3-vol-div-pct | 量價背離「漲>5%」 | [entryProhibitions.ts:23](../../lib/rules/entryProhibitions.ts#L23) | 書本只說「量價背離」 | 5% |
| PROHIB-4-weekly-dist | 週線壓力 3% 距離 | [entryProhibitions.ts:122](../../lib/rules/entryProhibitions.ts#L122) | 書本只說「遇壓力」 | 3% |
| PROHIB-short-7-pct | 做空盤整 < 15% | [entryProhibitions.ts:290](../../lib/rules/entryProhibitions.ts#L290) | 寶典 p.87 盤整 | ✅ 對齊書本 |
| R4-no-vol-mult | 量縮 0.5× | [eliminationFilter.ts:66](../../lib/scanner/eliminationFilter.ts#L66) | 書本「沒有量能」未量化 | 0.5× 為市場通用 |
| R6-resist-count | 近 10 天 ≥ 2 次壓力長黑 | [eliminationFilter.ts:101](../../lib/scanner/eliminationFilter.ts#L101) | 書本未量化次數 | ≥ 2 次 |
| R9-no-rise-pct | 5 日漲跌 < 3% | [eliminationFilter.ts:154](../../lib/scanner/eliminationFilter.ts#L154) | 書本只說「不漲」 | 3% |
| TRIPLE-tolerance / DOUBLE-tolerance | 三/雙重底容差 5% | [bookThresholds.ts:103-105](../../lib/analysis/bookThresholds.ts#L103) | 抓飆股 25 型態 | 5% |
| WEDGE-convergence | 楔形 1.2 倍 | [bookThresholds.ts:107](../../lib/analysis/bookThresholds.ts#L107) | 同上 | 1.2 |
| TREND-pos-end-5-bias | 末升段乖離 > 15% | [trendAnalysis.ts:474](../../lib/analysis/trendAnalysis.ts#L474) | 書本「遛狗理論」未量化 | 15%（用戶 2026-04-22 設定） |
| ALL-trailing-ma | 各字母不同的跟隨均線 | [v12StopLoss.ts](../../lib/sell/v12StopLoss.ts) | 書本「操作三線」未細分到字母 | code 自選每字母 |
| ALL-fixedPct (5/7/10%) | 各字母不同的固定%停損 | 同上 | 書本只明寫 F=7% 上限 | code 自選 |
| SELL-end-phase-trailing | 末升段 trailing = recentHigh × 0.97 | [v12StopLoss.ts:257](../../lib/sell/v12StopLoss.ts#L257) | 書本「移動停利」未量化 | 0.97 |
| TL-touch-pct | 切線觸碰判定 ±2% | [trendlineAnalytics.ts:76](../../lib/analysis/trendlineAnalytics.ts#L76) | 書本未量化 | 2% |
| SR-integer-tolerance | 整數關卡「近」1% | [supportResistance.ts:47](../../lib/analysis/supportResistance.ts#L47) | 書本「靠近整數關卡」未量化 | 1% |
| BOLL-parallel-width | 布林平行寬度差 < 10% | [bollingerPatterns.ts:93](../../lib/analysis/bollingerPatterns.ts#L93) | 書本只說「平行」 | 10% |

**建議行動**：第二類規則大多在 bookThresholds.ts 已加 JSDoc 標記。**這次 task 不動 code**。若未來要強化，建議統一加 `// IMPL_QUANTIFICATION` 註解便於識別。

---

### 第三類 ❌ 自創 / AI 補（書本完全沒寫）

這些是討論、AI 補充、或回測驅動的規則，沒有書本對應。**約 35 條**。

| rule_id | 規則 | code | 性質 | 建議 |
|---------|------|------|------|------|
| **D-flatbottom-narrow** | E 一字底 8% 窄幅 | [highWinRateEntry.ts:115-196](../../lib/analysis/highWinRateEntry.ts#L115) | 書本只寫「狹幅」 | 已標自創（docs 附錄 C）；可保留 |
| **D-flatbottom-vol-60** | E 一字底盤整期量縮 < 60% | 同上 | 書本只寫「量縮」 | 已標自創；可保留 |
| **D-flatbottom-lookback-120** | 一字底 120 天回看 | [bookThresholds.ts:96](../../lib/analysis/bookThresholds.ts#L96) | 書本未量化 | 已標自創 |
| **C-neckline-ratio** | C 上頸線最大上揚 1.05 倍 | [bookThresholds.ts:94](../../lib/analysis/bookThresholds.ts#L94) | 書本未量化 | 已標自創 |
| **MA20-warn-12** | MA20 乖離警示 12% | [bookThresholds.ts:98](../../lib/analysis/bookThresholds.ts#L98) | 書本 p.568「盡量避免追高」未量化 | 已標自創 |
| **R-mechanical-track** | **R 軌乖離率排名** | [StrategyConfig.ts:485](../../lib/strategy/StrategyConfig.ts#L485), [buyMethodTracks.ts:74](../../lib/scanner/buyMethodTracks.ts#L74) | **完全自創**：跳過六條件/戒律/淘汰/Step 0/MTF；long=MA20 乖離負最多、short=正最多 | **⚠️ 高風險，建議暫停評估** |
| **N-padding-far** | N 突破過頭 ×1.20 不視為進場 | [v12LetterN.ts:225](../../lib/analysis/v12LetterN.ts#L225) | 書本本意「不追過頭」未量化 | 已標自創（commit 21d659e） |
| **N-padding-target** | N 接近目標 ×0.97 不視為進場 | [v12LetterN.ts:233](../../lib/analysis/v12LetterN.ts#L233) | 書本未量化 | 已標自創 |
| **OP-super-long-30** | 超長線升級門檻 30% | [v12Operation.ts:157](../../lib/sell/v12Operation.ts#L157) | 書本只說「達高檔」 | 已標自創 |
| **SORT-primary-changePct** | 排序主鍵 = changePercent desc | [applyPanelFilter.ts:57](../../lib/selection/applyPanelFilter.ts#L57) | 書本未指定排序主鍵 | 2026-04-19 回測驅動，非書本 |
| **SELL-tp-reach-resist-2pct** | 停利「接近壓力 ±2%」 | [v12TakeProfit.ts:80](../../lib/sell/v12TakeProfit.ts#L80) | 書本「接近壓力」未量化 | 自創 padding |
| **A-six-cond-4-fresh** | 攻擊量「新鮮信號」過濾（前 2 日不可連續大量上漲） | [trendAnalysis.ts:755](../../lib/analysis/trendAnalysis.ts#L755) | 書本未提「新鮮性」概念 | 自創 |
| **chipDivergence-***（5 條） | 多頭/空頭背離：價±3% + 法人累積 ≥500 張 | [chipDivergence.ts](../../lib/analysis/chipDivergence.ts) | **整支檔案無書本標記** | **⚠️ 待確認來源** |
| **Display-thresholds**（13 條） | AI 信心、勝率色階、籌碼分級、KD 80/20、當沖比、9:25 集合競價、複合評分權重 | [bookThresholds.ts:160-212](../../lib/analysis/bookThresholds.ts#L160) | 顯示用，書本無 | 已標明，無風險 |
| **CHANNEL-min-gap-5** | 軌道線最少間隔 5 天 | [bookThresholds.ts:79](../../lib/analysis/bookThresholds.ts#L79) | 書本未量化 | 無註解 |
| **PIPELINE-min-stock** | TW 200 / CN 500 最少股數 abort | [ScanPipeline.ts:99](../../lib/scanner/ScanPipeline.ts#L99) | 防 API fallback 污染，非策略 | 工程性，無風險 |
| **PIPELINE-turnover-500** | 前 500 成交額過濾 | [ScanPipeline.ts:115](../../lib/scanner/ScanPipeline.ts#L115) | 回測冠軍組合 | 已標明 |
| **A-warn-vol-price-div thresholds** | 量價背離具體判定（價漲量縮等 3 種） | [trendAnalysis.ts:632](../../lib/analysis/trendAnalysis.ts#L632) | 書本 p.500-506 有概念，數字未量化 | 二類更接近 |

**建議行動**（按急迫性）：

1. 🔴 **R 軌乖離率排名（2026-05-21 新增）**：建議暫停評估。code 已存在但無書本依據，且跳過所有過濾，風險最高。
2. 🔴 **chipDivergence.ts 整支**：請確認是否引用任何書本/朱老師教學，若否，建議在檔頭加 `SOURCE: SELF-DERIVED` 註解（這次 task 不動 code）。
3. 🟡 **N padding（突破過頭、接近目標）**：commit message 標明是「過濾過頭已達標紀錄」實務需求，但與書本「真突破 ×3%」概念衝突，建議確認用戶意圖。
4. 🟡 **超長線升級 30%**：書本只說「達高檔」，30% 是 code 自選。可接受但需文件化。
5. 🟢 **D 一字底 8% / 60% / 120 天**：docs 附錄 C 已標「完全自創」，繼續使用無問題，但回測時應特別關注這些參數的敏感性。

---

### 第四類 📭 資料不足（網路課程、線上課，無書本素材）

這些規則依據「網路課程」「Podcast」「YouTube」「線上課 CH1-3」，沒有完整書本對照。**約 13 條**。

> ~~Q-three-ma / Q-stop-ma10~~ 已於 2026-05-22 二次審計移出本類 → 確認《抓住線圖股民變股神》p.262 原文記載 MA3/10/24 + 進場/出場/停損條件全部命中，現歸入第一類。

| rule_id | 規則 | code | 唯一依據 | 急迫性 |
|---------|------|------|----------|--------|
| **TIER1-ma20-slope** | MA20 斜率作為第三排序鍵（多頭時） | [applyPanelFilter.ts:61-65](../../lib/selection/applyPanelFilter.ts#L61) | 「2026-05-21 線上課程」（朱老師 CH3「均線三大力量」量化） | 🔴 高 |
| **TIER1-strong-in-weak** | D/F 觸發時偵測「弱中透強」加持 | [MarketScanner.ts:1400-1432](../../lib/scanner/MarketScanner.ts#L1400) | 朱老師 CH2-1（**林穎課程，但 commit 標朱老師**）— commit 來源混淆 | 🟡 中 |
| **TIER1-near-resist** | 「接近壓力區」位置判定 close ≥ swingHi × (1-3%) | [trendAnalysis.ts:498-517](../../lib/analysis/trendAnalysis.ts#L498) | 「2026-05-21 林穎 CH2 + 朱老師 CH3」 | 🟡 中 |
| **PROHIB-big-vol-mult-2** | 戒律 9 爆量 ×2 定義 | [entryProhibitions.ts:25](../../lib/rules/entryProhibitions.ts#L25) | 朱家泓《抓住飆股》+ 理財達人秀 YouTube #17 | 🟢 已標明 |
| **F-vrev-shape** | V 反轉變盤線型態 | [vReversalDetector.ts:55-67](../../lib/analysis/vReversalDetector.ts#L55) | 朱家泓《K 線交易法》（書名存在，但 docs 未找到對應頁碼） | 🟢 已標明 |
| **REENTRY-config** | 再進場規則（trigger=ma5/ma10 停損 + maxBars=10 + 趨勢未破 + 重新站上均線 + 量 ≥ 5MA × 0.8） | [StrategyConfig.ts:173-180](../../lib/strategy/StrategyConfig.ts#L173) | 「書本戰法 1 波浪 / 戰法 4 二條均線」（無頁碼） | 🟡 中 |

**重要發現**：
- 朱家泓**免費體驗課 PDF**（73 頁，p37 第三大金剛）官方均線是 **MA5/10/20/60** ── 此為**入門均線教學體系**，不是「三均線戰法」。
- 朱家泓「三均線戰法」原文位於《抓住線圖股民變股神》第 4 篇第 8 章 p.261-265，2026-05-22 二次審計從 OCR 確認原文：**三均線 = MA3/10/24**（書本 p.262 明寫「採用3日均線及10日均線為操作進出依據。24日均線做為趨勢判定」）。p37「第三大金剛 MA5/10/20/60」與 p.262「三均線戰法 MA3/10/24」**是不同戰法，並無衝突**。
- PDF p63 STEP 04「三條均線做多」術語存在（朱家泓官方用語），三條具體均線數字 PDF 雖未指明，但已由書本 p.262 補完。

**建議行動**：
1. ~~Q 戰法均線確認~~ → **已完成（2026-05-22）**。
2. 🔴 **Tier 1 三項對齊**：朱老師 CH3、林穎 CH2 的書本對應頁碼需要使用者補課程筆記（commit 669f273 message 已混用「書本/線上課程」字眼）。
3. 🟡 **線上課 CH1-3 完整筆記化**：建議使用者錄音整理為 docs/zhu_online_course_ch1.md / ch2.md / ch3.md。

---

### 第五類 🔄 已偏離書本（原本對齊、後來手動修改）

這些規則 git 歷史顯示原本對齊書本，後來使用者主動修改偏離。**約 15 條**。

| rule_id | 規則 | code | 書本原文 | 現況 | commit |
|---------|------|------|----------|------|--------|
| ~~HIGH_DEVIATION_PCT~~ → ✅ 已修復 | MA20 乖離上限 | [bookThresholds.ts:142](../../lib/analysis/bookThresholds.ts#L142) | 書本 p.568 = 15% | **2026-05-22 回滾為 15%** | 496309e（2026-05-20）→ 已回滾 |
| ~~R-warn-not-block~~ → ✅ 已修復 | 淘汰法執行方式 | [MarketScanner.ts:494](../../lib/scanner/MarketScanner.ts#L494) | 書本「立即出場」 | **2026-05-22 回滾為 hard gate** | 496309e（2026-05-20）→ 已回滾 |
| **KD-declining-warn** | KD 向下不買 gate | [v12Conditions.ts:71-72](../../lib/analysis/v12Conditions.ts#L71) | 書本短線規則 #9 | **flag 保留但不擋** | 496309e（2026-05-20） |
| **Phase-C-ratio-098** | LockWatch Phase C 過濾 close 接近頸線 | [features/lockwatch/](../../features/lockwatch/) | 原 ×0.95 / 70% | **×0.98 / 80%** | e813eee（2026-05-11） |
| **Q-no-prohibitions** | Q 戰法軌移除戒律 reject | [scanner/...](../../lib/scanner/) | 書本 Q 戰法未明寫「不適用戒律」 | **跳過戒律** | 2698969（2026-05-11） |
| **N-padding-12-097** | N 突破過頭 / 接近目標 padding | [v12LetterN.ts:225-235](../../lib/analysis/v12LetterN.ts#L225) | 書本「真突破 ×3%」 | **新增 padding** | 21d659e（2026-05-11） |
| ~~PROHIB-3 deviation 25~~ → ✅ 已修復 | 戒律 3 乖離門檻 | [entryProhibitions.ts:96](../../lib/rules/entryProhibitions.ts#L96) | 書本只說「乖離過大」 | **2026-05-22 與 HIGH_DEVIATION_PCT 連動回 15%** | 995c3a9 |
| ~~ZHU-PURE-BOOK devMax~~ → ✅ 已修復 | A 策略 devMax | [StrategyConfig.ts:214](../../lib/strategy/StrategyConfig.ts#L214) | 「ZHU_PURE_BOOK」應 100% 書本，原 15% | **2026-05-22 回到 15%** | 995c3a9 |

#### 各偏離點的回滾方案

**✅ 回滾 1：HIGH_DEVIATION_PCT 從 0.25 回到 0.15**（2026-05-22 完成，commit `995c3a9`）

- 改動檔案：[lib/analysis/bookThresholds.ts:142](../../lib/analysis/bookThresholds.ts#L142) + 連動 7 處 + 2 個測試
  ```ts
  export const HIGH_DEVIATION_PCT = 0.15;  // 書本 p.568 原文
  ```
- 連動影響（已實作）：戒律 3 / 做空戒律 3 / Step 5 ② 切 MA5 / BASE_THRESHOLDS / ZHU_PURE_BOOK / `evaluateSixConditions` devMax 預設 / B/P 進階紀律 override
- A/B 回測（4.5 個月、TW、54 組合）：詳見 [rollback-backtest](./2026-05-22-high-deviation-pct-rollback-backtest.md)
  - v12 cron 生產線：**零影響**（v12StockEvaluator 不走 SIXCOND）
  - SIXCOND 冠軍：報酬 +155% → +108%（−30%）、勝率 44% → **53%**（+8.5pp）、回撤 25% → 33%
  - 結論：書本對齊 + 勝率上升，不建議改回 25%

**✅ 回滾 2：淘汰法回到「立即出場」— 2026-05-22 完成**

- 改動檔案：[lib/scanner/MarketScanner.ts:494](../../lib/scanner/MarketScanner.ts#L494)（已加回 `if (elimination.eliminated) return null`）
- 同步更新：[candidateCollector.ts:137](../../lib/backtest/optimizer/candidateCollector.ts#L137) 本來就是 hard gate，生產與回測現已對齊
- 實測影響（60 交易日 anchor 2026-05-21）：
  - TW: 池子 181.2 → 161.0 檔/日（縮小 **12.3%**，範圍 5.0%–28.6%）
  - CN: 池子 240.5 → 230.3 檔/日（縮小 **5.1%**，範圍 0.8%–25.7%）
  - 規則熱點：TW 以 R4（量縮）為主、CN 以 R2（重壓不過破MA5）為主
- 詳細報告：[2026-05-22-elimination-hard-gate-impact.md](./2026-05-22-elimination-hard-gate-impact.md)
- 風險：可控。多頭軌 8 字母仍有 161/230 檔可選，無 pool 飢餓
- 量測工具：[scripts/measure-elimination-impact.ts](../../scripts/measure-elimination-impact.ts)（日後 regression check 可重用）

**🔄 回滾 3：KD 向下不買 gate 恢復**

- 改動檔案：[lib/analysis/v12Conditions.ts:71-72](../../lib/analysis/v12Conditions.ts#L71)
- 影響：KD 死叉或 K 下降時不可進場
- 風險：可能錯失強勢回檔買點

**🔄 回滾 4：LockWatch Phase C 收緊參數回到 ×0.95 / 70%**

- 改動檔案：[features/lockwatch/](../../features/lockwatch/)（具體位置待查）
- 影響：鎖股觀察清單範圍變寬
- 風險低（LockWatch 是輔助觀察，不影響選股）

**🔄 回滾 5：Q 戰法恢復戒律 reject**

- 改動檔案：對應 Q 軌過濾邏輯
- 影響：Q 戰法觸發頻率下降
- 連動：書本本意未明確「Q 不適用戒律」，回滾可能更安全

**🔄 回滾 6：N padding（×1.20 / ×0.97）移除**

- 改動檔案：[lib/analysis/v12LetterN.ts:225-235](../../lib/analysis/v12LetterN.ts#L225)
- 影響：N 字母信號更頻繁
- 評估：commit message 標「過濾過頭已達標紀錄」是實務需求，移除前需確認

**建議行動**：
- 🔴 立即決定第五類每一項是要保留「使用者放寬版」還是回滾到「書本原文」
- 🟡 回滾前先在 `__tests__/contracts/scan-parity.test.ts` 加 baseline，方便比對影響
- 🟢 不要一次回滾全部，按急迫度逐項處理

---

## 文件 Stale 缺口

**核心污染**：[docs/STRATEGY_BOOK_REFERENCE.md](../STRATEGY_BOOK_REFERENCE.md) 最後改動 2026-04-21，但 lib/ 在這之後有大量策略改動完全沒進文件。

### Stale 改動清單（2026-04-21 後對 lib/ 的策略性 commit）

| commit | 日期 | 改動 | 文件狀態 |
|--------|------|------|---------|
| 8d4f31a | 2026-05-08 | v12 Phase 0.2 共用 helpers + 完整規格文件 | ❌ 未進 STRATEGY_BOOK_REFERENCE |
| 99bd8da | 2026-05-08 | v12 Phase 1.1 Step 0 大盤過濾（書本明寫前提） | ❌ |
| 078b1ad | 2026-05-08 | v12 Phase 1.2 純書本條件 helpers | ❌ |
| 230c941 | 2026-05-08 | v12 Phase 1.3 訊號 Gate Helpers | ❌ |
| 9d0f56f | 2026-05-08 | v12 Phase 1.4A 字母 mapping J/K/L | ❌ |
| a60a259 | 2026-05-08 | v12 Phase 1.4B 5 個新訊號 detector（M/N/O/P/Q） | ❌ |
| b6b24ad | 2026-05-08 | v12 Phase 1.6/1.7/1.8 LockWatch + Provisional + Step 3 停損 | ❌ |
| 390cd3c | 2026-05-08 | v12 Phase 1.9/1.10/1.11 操作 + 停利 + 出場路徑分流 | ❌ |
| 1c94c41 | 2026-05-09 | v12 8 audit bugs — deviation gate / abs stop / provisional | ❌ |
| e86bf8e | 2026-05-09 | v12 round-2 audit — F vBottom + LockWatch | ❌ |
| 1681bb9 | 2026-05-09 | v12 LockWatch 儲存層 + API + UI | ❌ |
| fa989bd | 2026-05-09 | v12 五步法全面對齊書本 + LockWatch UX | ❌ |
| dfbcaa5 | 2026-05-10 | 結構失效改用真跌破門檻（頸線×0.97 / ×1.03） | ❌ |
| af190d0 | 2026-05-10 | 策略 B 站回 MA5 → 放量突破跨日 N≤3 | ❌ |
| 2698969 | 2026-05-11 | Q 戰法軌移除戒律 reject | ❌ |
| 21d659e | 2026-05-11 | lockwatch 過濾「突破過頭」(×1.20) | ❌ |
| 0fab0ae | 2026-05-11 | Phase C close < target × 0.97 過濾 | ❌ |
| e813eee | 2026-05-11 | Phase C 過濾收緊 ×0.95→×0.98 / 70%→80% | ❌ |
| 7d3c0f9 | 2026-05-10 | Phase C 鎖股觀察改成「即將突破」清單 | ❌ |
| e23962d | 2026-05-13 | ABCDE D-medium — 6 個自創常數搬 bookThresholds | ❌ |
| 496309e | 2026-05-20 | **乖離 15% → 25%、KD 向下 + 淘汰法改警示** | ❌ |
| b33fa2f | 2026-05-21 | **乖離率(R)策略 + 機械軌** | ❌ |
| 669f273 | 2026-05-21 | **Tier 1 三項書本對齊** | ❌ |

**總計**：**至少 23 個策略性 commit** 改動了 lib/ 但完全沒進 STRATEGY_BOOK_REFERENCE.md。文件當前狀態相當於描述「2026-04-20 時的 rockstock」，與現在的 code 差距已經有一個月+ 的偏移。

**建議行動**：本報告完成後，spawn 獨立 task 補齊 STRATEGY_BOOK_REFERENCE.md，至少把上述 23 個 commit 的對應條目補完。

---

## PDF 比對結果摘要

**檔案**：`~/Downloads/朱家泓｜技術分析全攻略｜免費體驗課｜體驗課精華秘籍.pdf`（73 頁、12.5MB）
**性質**：免費體驗課行銷簡報，框架口號為主，量化數字極少

### PDF 確認的項目（rockstock 規則可引用）

| # | 主題 | PDF 對應 | rockstock 規則 | 結論 |
|---|------|---------|---------------|------|
| 1 | 六條件清單名稱（趨勢／位置／K線轉折／均線／成交量／指標） | p63 STEP 01 | A 策略六條件 | ✅ **PDF 確認名稱與分類** |
| 2 | 「攻擊量」與「爆大量」是兩個獨立分類 | p37 第四大金剛 | BOOK_VOL_RATIO_MIN ×1.3 vs BOOK_HIGH_VOLUME_MULT ×2.0 | ✅ **PDF 確認兩量分立**（倍數無據） |
| 3 | 「三均線戰法」術語存在 | p63 STEP 04「三條均線做多」 | Q 字母 | ✅ **PDF 確認術語**；三條具體均線（MA3/10/24）由《抓住線圖股民變股神》p.262 原文補完（2026-05-22 二次審計） |
| 4 | 紀律 4 條：順趨勢／等K線／守均線／看成交量 | p31 | 籠統對應戒律精神 | ✅ |
| 5 | 「高檔爆量、股價不漲」概念 | p55 | 戒律 9 + R9 淘汰 | ✅ 概念對應，數字無據 |

### PDF 未提及的項目（rockstock 規則無法靠這份 PDF 驗證）

- 十大戒律完整清單
- R1-R11 淘汰法完整清單
- 高勝率 6 位置完整清單
- 均線糾結具體 %（MA5/10/20 spread）
- 盤整狹幅具體 %
- 一字底窄幅 / 量縮 / 盤整天數
- 乖離率任何具體門檻（15% / 22.5% / 25%）
- MA20 斜率排序
- 「弱中透強」用語
- 接近壓力區距離 %
- 停損 7% / 停利 10% 具體數字
- 爆量 ×1.3 / ×2 具體倍數

### PDF 衝突項

~~**Q 三均線戰法**：PDF p37 第三大金剛官方均線是 **MA5/10/20/60**，而 rockstock Q 戰法用 **MA3/10/24**。~~

**2026-05-22 二次審計排除此衝突**：經查《抓住線圖股民變股神》第 4 篇第 8 章 p.262 OCR 原文確認：「採用3日均線及10日均線為操作進出依據。24日均線做為趨勢判定」。朱家泓本人將「三均線戰法」明確定義為 MA3/10/24，p37「第三大金剛 MA5/10/20/60」是入門均線教學體系，兩者**屬不同戰法/教學階段，無衝突**。Q 戰法 code（[v12LetterQ.ts](../../lib/analysis/v12LetterQ.ts)）與書本 p.262 完全一致（進場 / 出場 / 停損條件全部命中）。

審計後本欄無實質衝突項。

---

## 暫停 / 觀察 / 維持的具體建議

### 🛑 建議暫停使用（生效中但風險高）

| 規則 | 原因 | 影響 |
|------|------|------|
| ~~R 軌乖離率機械排名~~ → ⏸ **已暫停 2026-05-22** | 完全自創、跳過所有過濾 → cron 移除 | code 保留，回測可用；恢復 = 加回 cron |
| ~~淘汰法「警示不擋」~~ → ✅ **已修復 2026-05-22** | 偏離書本「立即出場」→ 回滾為 hard gate | 實測 TW -12.3%、CN -5.1%，影響可控 |

### ⏸ 建議觀察（保留但需後續驗證）

| 規則 | 原因 |
|------|------|
| ~~HIGH_DEVIATION_PCT = 25%~~ → ✅ **已回滾 15% 2026-05-22** | 偏離書本 15% → 對齊書本 |
| ~~KD 向下不擋~~ → ✅ **已恢復 hard gate 2026-05-22** | 偏離書本短線規則 #9 → 對齊書本 |
| **N padding（×1.20 / ×0.97）** | 偏離書本「真突破 ×3%」 |
| **Tier 1 三項（MA20 斜率 / 弱中透強 / 接近壓力區）** | 線上課程依據未經書本固化 |
| **chipDivergence.ts** | 整支檔案無書本標記 |

### ✅ 維持使用（書本對齊度高、無爭議）

- 六條件 ①-⑥
- 十大戒律（除戒律 3 乖離 25% 偏離外）
- 淘汰法 R1/R2/R4/R5/R6/R7/R9 條件 + 執行方式（2026-05-22 起對齊書本「立即出場」hard gate）
- 高勝率 6 位置加分
- B/C/D/E/F/J/K/L/M/N/O/P 字母核心邏輯
- 停損 7% / 停利 10% 框架
- 布林、切線、支撐阻力、指標型態（全部書本明確）

---

## 後續任務清單

以下任務會以 `spawn_task` 開獨立背景 session 跟進（不影響本對話）：

### 第三類（自創規則確認）
- ~~T1: 確認 R 軌（乖離率排名）是否要保留或暫停~~ → **2026-05-22 完成**，已暫停自動掃描
- T2: 確認 `chipDivergence.ts` 來源（書本？自創？AI 補？）
- T3: 確認 N padding（×1.20 突破過頭、×0.97 接近目標）是否要保留
- T4: 確認排序主鍵 changePercent desc 是否要明文標為「回測驅動非書本」

### 第四類（資料補齊）
- ~~T5: 確認 Q 戰法三均線（MA3/10/24 vs MA5/10/20/60）~~ → **已完成（2026-05-22）**，書本 p.262 對齊
- T6: 整理線上課 CH1（朱老師：趨勢）筆記
- T7: 整理線上課 CH2（林穎：K 線）筆記
- T8: 整理線上課 CH3（朱老師：均線）筆記

### 第五類（回滾評估）
- ~~T9: 評估 HIGH_DEVIATION_PCT 從 25% 回到 15% 的影響（含全字母回測）~~ → **已完成（2026-05-22）**，A/B 回測寫入 [2026-05-22-high-deviation-pct-rollback-backtest.md](./2026-05-22-high-deviation-pct-rollback-backtest.md)
- ~~T10: 評估淘汰法回到「立即出場」的影響~~ → **已完成（2026-05-22）**，回滾完成、影響量測寫入 [2026-05-22-elimination-hard-gate-impact.md](./2026-05-22-elimination-hard-gate-impact.md)
- T11: 評估 KD 向下不擋 → 恢復 gate 的影響
- T12: 評估 Q 軌恢復戒律 reject 的影響（書本 p.262 未明寫 Q 不適用戒律，回滾可能更安全）

### 文件 Stale
- T13: 更新 `docs/STRATEGY_BOOK_REFERENCE.md` 補齊 2026-04-21 後的 23 個 commit 對應條目

---

## 附錄 A：審計範圍涵蓋的檔案

### 已讀（主 context）
- [lib/analysis/bookThresholds.ts](../../lib/analysis/bookThresholds.ts)
- [docs/STRATEGY_BOOK_REFERENCE.md](../STRATEGY_BOOK_REFERENCE.md)

### Sub-agent 讀過並 extract（規則總表來源）
- lib/selection/applyPanelFilter.ts
- lib/strategy/StrategyConfig.ts
- lib/scanner/buyMethodTracks.ts
- lib/scanner/ScanPipeline.ts
- lib/scanner/MarketScanner.ts
- lib/scanner/eliminationFilter.ts
- lib/rules/entryProhibitions.ts
- lib/analysis/v12Conditions.ts
- lib/analysis/trendAnalysis.ts
- lib/analysis/highWinRateEntry.ts
- lib/analysis/breakoutEntry.ts
- lib/analysis/vReversalDetector.ts
- lib/analysis/gapEntry.ts
- lib/analysis/abcBreakoutEntry.ts
- lib/analysis/klineConsolidationBreakout.ts
- lib/analysis/blackKBreakoutEntry.ts
- lib/analysis/v12LetterN.ts / v12LetterM.ts / v12LetterO.ts / v12LetterP.ts / v12LetterQ.ts
- lib/analysis/chipDivergence.ts
- lib/analysis/bollingerPatterns.ts
- lib/analysis/trendlineAnalytics.ts
- lib/analysis/supportResistance.ts
- lib/analysis/indicatorPatterns.ts
- lib/sell/v12StopLoss.ts
- lib/sell/v12TakeProfit.ts
- lib/sell/v12Operation.ts

### Sub-agent 讀過 PDF
- ~/Downloads/朱家泓｜技術分析全攻略｜免費體驗課｜體驗課精華秘籍.pdf（73 頁）

---

## 附錄 B：審計方法限制

1. **PDF 限制**：只覆蓋免費體驗課，不是六本書完整內容。許多書本明確標頁碼的規則無法靠 PDF 二次驗證。建議下次審計時提供完整書本 OCR PDF。
2. **線上課限制**：CH1-3 沒有逐字稿，第四類項目無法在本次審計內驗證來源。
3. **書本對照文件信任度**：STRATEGY_BOOK_REFERENCE.md 是 2026-04-20 整理結果。本審計信任順序：**PDF（最高）> 書本 OCR > STRATEGY_BOOK_REFERENCE.md > code 註解**。當有衝突時以 PDF/書本為準。
4. **規則總數估算**：220 條是 sub-agent 盤點結果，可能仍有遺漏（如各字母的 detail/log 格式、UI 顯示用 helper 等邊緣規則）。
5. **本次審計不修改 code**。所有「建議行動」是供使用者決策，實際執行需另開 task。
