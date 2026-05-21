# 策略與書本對照完整參考

> 本文件整理 rockstock 全部選股策略與規則對應朱家泓書本的出處，含實作檔案、書本出處、細節描述、與書本偏離備註。
>
> **查證來源順序**（用戶指令）：
> 1. 6 本書（寶典 / 5步驟 / 抓住K線 / 抓住飆股 / 抓住線圖 / 林穎走圖SOP）
> 2. 朱家泓網路資料（Smart 月刊、痞客邦書摘、YouTube 理財達人秀、Podcast、線上課 CH1-3）
> 3. 實在找不到才標「自創」並加 JSDoc
>
> **書本 = 文字 + 圖表**：文字或圖任一有寫就是書本要求；都沒寫就禁止自創加碼。

**最後更新**：2026-05-22

> **本次更新（2026-05-22）**：整體擴展涵蓋 v12 字母軌道（J/K/L/M/N/O/P/Q/R 9 個新字母）、軌道架構（多頭軌/反轉軌/戰法軌/機械軌）、Tier 1 三項對齊、Phase C 過濾、停損停利 v12、與 2026-05-20 以後的偏離書本項目。原始基礎為 2026-04-21 整理。完整 stale commit 清單見 [docs/audit/2026-05-22-knowledge-contamination-audit.md](audit/2026-05-22-knowledge-contamination-audit.md)。

---

## 📋 策略分類總覽

### v12 字母軌道架構（單一事實來源：[lib/scanner/buyMethodTracks.ts](../lib/scanner/buyMethodTracks.ts)）

rockstock 選股以「字母軌道」分流，每個軌道過濾規則不同：

| 軌道 | 字母 | 來源 | Step 0 大盤 | Step 1 池子（六條件+戒律+淘汰）| Step 2 訊號 | Step 3+ |
|---|---|---|---|---|---|---|
| **A 池子** | A | 寶典 p.54 等 | ✅ 過 | ✅ 自身就是 | — | — |
| **多頭軌** | B / C / E / J / K / L / M / P | 寶典 Part 11-1 八種位置 + 5 步驟 p.40 | ✅ 過 | ✅ **必過** | 各字母 detector | LockWatch / 停損停利 |
| **反轉軌** | D / F / N / O | 抓飆股 25 型態 + 寶典 Part 12 祕笈 + Part 11-1 第 1/7 位置 | ✅ 過 | ❌ 不過（反轉本就在底部空頭翻多時） | 各字母 detector | LockWatch / 停損停利 |
| **戰法軌** | Q | 抓住線圖 第 4 篇第 8 章 p.261-265 ✅（2026-05-22 OCR 確認 MA3/10/24 對齊書本）| ✅ 過 | ❌ 不過（自帶 SOP）| Q SOP（MA3+MA10 黃金叉）| Q 守 MA10 |
| **機械軌** | R | ❌ **完全自創**（2026-05-21 用戶要求新增）| ❌ 不過 | ❌ 不過 | 成交額前 500 → MA20 乖離排名 | — |

**v11 → v12 字母對照**（讀舊資料用，新代碼不寫 v11）：
- `G` → `J`（ABC 突破）
- `H` → `L`（過大量黑 K）
- `I` → `K`（K 線橫盤）

### 全字母總表（v12 命名）

| 字母 | 名稱 | 軌道 | 書本依據 | 實作 |
|---|---|---|---|---|
| **A** | 六條件池子 | 池子 | 寶典 p.54 | `trendAnalysis.ts` + `entryProhibitions.ts` + `eliminationFilter.ts` |
| **B** | 回後買上漲 | 多頭 | 寶典 Part 11-1 位置 2 / 5 步驟 p.40 / 寶典 p.238-244 | `breakoutEntry.ts pullback_buy` |
| **C** | 盤整突破 | 多頭 | 寶典 Part 11-1 位置 1 / 5 步驟 p.40 | `breakoutEntry.ts consolidation_breakout` |
| **D** | 一字底 | 反轉 | 抓住飆股 25 型態 #9 | `highWinRateEntry.ts detectStrategyE`（函數名歷史殘留）|
| **E** | 缺口 | 多頭 | 5 步驟 p.40 位置 4 | `gapEntry.ts detectStrategyD`（函數名歷史殘留）|
| **F** | V 型反轉 | 反轉 | 寶典 Part 12 祕笈圖 #1 + 抓住K線 第 7 篇 +《抓住飆股》p.316 | `vReversalDetector.ts` |
| **J** | ABC 突破（原 G）| 多頭 | 寶典 Part 11-1 位置 6 p.697 + Part 12-4 祕笈 #16 p.815 | `abcBreakoutEntry.ts` |
| **K** | K 線橫盤（原 I）| 多頭 | 寶典 Part 11-1 位置 3 p.694 + Part 12-4 祕笈 #5 p.802 | `klineConsolidationBreakout.ts` |
| **L** | 過大量黑 K（原 H）| 多頭 | 寶典 Part 11-1 位置 8 p.699 + Part 12-4 祕笈 #9 p.806 | `blackKBreakoutEntry.ts` |
| **M** | 突破上升軌道線 | 多頭 | 寶典 Part 5 p.387 + Part 12-4 祕笈 #18 p.822 | `v12LetterM.ts` |
| **N** | 型態確認 | 反轉 | 寶典 Part 11-1 位置 7 p.697 + 抓飆股 p.314-342 | `v12LetterN.ts` |
| **O** | 打底完成 | 反轉 | 寶典 Part 11-1 位置 1 p.691 | `v12LetterO.ts` |
| **P** | 高檔拉回 | 多頭 | 寶典 Part 11-1 位置 3 p.693「等拉回」 | `v12LetterP.ts` |
| **Q** | 三條均線戰法（MA3/10/24）| 戰法 | 抓住線圖 第 4 篇 第 8 章 p.261-265 ✅（2026-05-22 OCR 確認，與 PDF 不衝突）| `v12LetterQ.ts` |
| **R** | 乖離率機械軌 | 機械 | ❌ **完全自創** | `MarketScanner.ts` + `StrategyConfig.ts:485` |

### 走圖輔助信號（不影響進出場）

| 信號 | 書本 | 實作 |
|---|---|---|
| **K 線型態** | 寶典 Part 3 p.199-245（變盤線/反轉/繼續 3 類全實作）| `klinePatterns.ts` |
| **切線突破警示** | 寶典 p.37/p.38 | `trendlineAnalysis.ts` |
| **量價背離**（檔名仍為 `chipDivergence` 是 v11 殘留）| 寶典 p.57 戒律 3 量價背離部分 + 5 步驟 量價 13 條 ✅（2026-05-22 已修正）| `chipDivergence.ts`（僅走圖頂部 banner，不進選股）|

### 篩選開關（UI toggle 可關閉）

| 開關 | 書本 | 實作 |
|---|---|---|
| **MTF 長線保護短線**（週線版六條件）| 5 步驟「長線保護短線」+ 朱家泓實例（伍豐/宣德）| `multiTimeframeFilter.ts` |

---

# 一、池子 A：六條件 + 戒律 + 淘汰

A 池子由四個子系統組成：**六條件（硬 gate）+ 高勝率 6 位置（加分）+ 十大戒律（硬擋）+ R1-R11 淘汰法（硬踢）**。

多頭軌（B/C/E/J/K/L/M/P）的訊號必須先通過 A 池子才能成立。

### 1.1 進場六條件（硬 Gate，前 5 必過）

**書本**：寶典 p.54
**實作**：[lib/analysis/trendAnalysis.ts](../lib/analysis/trendAnalysis.ts) `evaluateSixConditions`

| # | 條件 | 書本原文 | 實作 |
|---|---|---|---|
| ① | 趨勢多頭 | 頭頭高底底高 | findPivots MA5 分段法（p.22）找轉折，最新兩波頭高於前波、底高於前底 |
| ② | 均線多排+向上 | MA10/MA20 多排+向上（MA60 在上方下彎=警示非 gate）| `MA5>MA10>MA20` 三線多排 + MA10/MA20 今日 > 昨日（1 根比較，對齊看盤軟體箭頭） |
| ③ | 股價位置 | 收盤 > MA10 且 > MA20 | `close > MA10 AND close > MA20` |
| ④ | 攻擊量 | 前日 × 1.3 | `volume >= prev.volume × 1.3` |
| ⑤ | 紅K實體 | ≥ 2% + 高收盤 + 上影 ≤ 實體 | `(close-open)/open ≥ 0.02` + 收在上半段 + `上影 ≤ 實體絕對值`（書本原文「長上影=上影>實體」）|
| ⑥ | 輔助指標 | MACD 綠縮或紅延 + KD 金叉 | 任一成立即加分，**非 gate** |

> ✅ **2026-05-22 已回滾**：條件 ⑥ 內的 KD 向下警示原本是 gate（書本短線規則 #9），2026-05-20 曾被改成 flag 保留但不擋，2026-05-22 回滾為 hard gate 對齊書本（[MarketScanner.ts:471-477](../lib/scanner/MarketScanner.ts#L471)）。詳見「附錄 D：偏離書本項目」。

---

### 1.2 高勝率 6 位置（加分，每位置 +5，上限 +30）

**書本**：寶典 Part 12 p.749-755
**實作**：[lib/analysis/highWinRateEntry.ts](../lib/analysis/highWinRateEntry.ts)

**6 位置共通要求**（位置 1-3/5 必過）：
- 紅K實體 ≥ 2%
- 收盤突破 MA5
- 大量（≥ 5 日均量 × 1.3）
- 均線 **4 線多排**：MA5 > MA10 > MA20 > MA60（書本明確）

| 位置 | 書本明確條件 | 實作 | 偏離 |
|---|---|---|---|
| **1 多頭打底確認** | 頭頭高底底高 + 4線多排 + 突MA5 + 大量 + 紅K>2% | `detectTrend === '多頭'` + 其他書本 4 項 | ✅ 100% |
| **2 回檔不破前低** | 不破底底高結構 + 4線多排 + 紅K突MA5 + 大量 | findPivots 最新波谷 ≥ 前一波谷（0 容差）+ 書本 4 項 | ✅ 100% |
| **3 突破盤整上頸線** | 突破兩頭連線上頸線 + 4線多排 + 大量 + 紅K | findPivots 兩 high pivots 連線延伸值 | ✅ 100% |
| **4 均線糾結突破** | 紅K突3/4線糾結 + 大量 | 前日 MA5/10/20 spread < 3% + 今日突三線 | ⚠️ 3% 糾結閾值書本未量化（實務 1-3% 上限）|
| **5 強勢股回檔續攻** | 4線多排 + 回檔 1-2 天黑K + 黑K大量 + 續攻紅K + 紅K大量 + 突黑K高點 | 前 1-2 天黑K+**黑K也大量**（圖 12-1-6 標示）+ 今日紅K+量+突黑K高點 | ✅ 100%（按圖 12-1-6）|
| **6 假跌破真上漲** | 假跌破（破下頸線）+ 真上漲紅K + 大量 + 突上頸線 | findPivots 兩頭=上頸線、兩底=下頸線；前 1-3 天破下頸線 + 今日紅K大量 + 突上頸線 | ✅ 100%（按圖 12-1-7）|

---

### 1.3 十大戒律（硬擋進場，任一觸發即不進場）

**書本**：寶典 p.57-58
**實作**：[lib/rules/entryProhibitions.ts](../lib/rules/entryProhibitions.ts)

| # | 書本原文 | 實作 | 偏離 |
|---|---|---|---|
| **1** 未突破月線勿做多 | close > MA20 | 併入六條件 #3 | ✅ |
| **2** 上漲第3根以上勿追高 | 連 3 紅K 勿追 | 從當日往前數連續紅K，≥ 3 即擋 | ✅ |
| **3** 量價背離+KD高+乖離（3項合一）| 三項「搭配」同時成立 | 量價背離（近3日漲>5% + 縮量）AND K>80 AND MA20乖離 > `HIGH_DEVIATION_PCT` | ✅ **2026-05-22 已回滾**：HIGH_DEVIATION_PCT 從 25% 回到書本 p.568 的 15%（[bookThresholds.ts:142](../lib/analysis/bookThresholds.ts#L142)） |
| **4** 週線遇壓力 | 週線最近的頭 = 壓力 | findPivots 最近一個週線 high pivot，今日距 < 3% | ✅ 書本；⚠️ 3% 實作詮釋 |
| **5** 未站上月線 | 收盤未站上 MA20 | `close < MA20` 直接擋 | ✅ 書本簡化 |
| **6** 回檔底底低 | 跌破前低勿做多 | findPivots 最新波谷 < 前波谷（0 容差）| ✅ 100% |
| **7** 盤整區內勿做多 | 不是頭頭高底底高、也不是頭頭低底底低 | `detectTrend === '盤整'` | ✅ 100% |
| **8** 空頭反彈 | 空頭紅K反彈勿追 | `detectTrend === '空頭'` + 今日紅K | ✅ 100% |
| **9** 連3急漲大量長紅 | 連 3 根急漲爆量 | 近 3 根都是紅K實體>2% + 量 > 前日×2（爆量 context）| ✅ 100% |
| **10** 黑K不進場 | 紅K gate | 併入六條件 #5 | ✅ |
| ~~**11** 第一次回檔不破原始上升切線~~ | — | **已移除**（2026-04-20 用戶決議）| — |

> **2026-05-11 Q 戰法軌偏離**：Q 戰法（戰法軌）不適用十大戒律 reject（commit 2698969）。書本未明寫「Q 不適用戒律」，純實務決議。詳見「附錄 D：偏離書本項目」。

---

### 1.4 R1-R11 淘汰法（硬踢，任一即排除）

**書本**：寶典 Part 10 p.659-662
**實作**：[lib/scanner/eliminationFilter.ts](../lib/scanner/eliminationFilter.ts)

| R | 書本原文 | 實作 | 偏離 |
|---|---|---|---|
| R1 | 沒走出底部 | 均線空排 + 股價 < MA20 | ✅ |
| R2 | 重壓跌破 MA5 | 前高壓力 + 收盤跌破 MA5 | ✅ |
| R3 ~~趨勢不明確~~ | — | **已移除**（2026-04-20 用戶決議）| — |
| R4 | 沒有量能 | `volume < avgVol5 × 0.5` | ⚠️ 0.5× 市場通用（朱家泓只分有/無量）|
| R5 | 大幅上漲 1 倍+盤整 | `close > 60 日低 × 2` AND `detectTrend === '盤整'` | ✅ |
| R6 | 壓力大量長黑 | 近 10 天壓力區出現 2 次以上大量長黑K | ✅ |
| R7 | 頭頭低+指標背離 | 趨勢頭頭低 + MACD/KD 背離 | ✅ |
| R8 ~~法人連續賣超~~ | — | **已移除**（無法人資料，代理不準）| — |
| R9 | 頻頻爆大量股價不漲 | 近 6 日 3 天量 > 前日×2（爆量）AND 5 日漲幅 < 3% | ✅ 爆量×2 對齊朱家泓《抓住飆股》|
| R10 ~~看不懂長期盤整~~ | — | **已移除**（30/8%/2% 完全自創）| — |
| R11 ~~基本面好沒技術面~~ | — | **已移除**（基本面超出系統範圍）| — |

**邏輯**：任一 R 條件命中即淘汰（2026-04-20 移除「嚴重/一般」分級）

> ✅ **2026-05-22 已回滾**（第五類偏離項已修復）：淘汰法執行方式 2026-05-20 commit 496309e 曾被改為「警示不擋」，2026-05-22 回滾為 hard gate 對齊書本「立即出場」（[MarketScanner.ts:493-497](../lib/scanner/MarketScanner.ts#L493)）。實測影響：TW 池子 -12.3%、CN -5.1%、仍剩 161/230 檔可選，無 pool 飢餓風險。詳見 [docs/audit/2026-05-22-elimination-hard-gate-impact.md](audit/2026-05-22-elimination-hard-gate-impact.md)。

---

# 二、多頭軌（B/C/E/J/K/L/M/P）

多頭軌字母**必須先過 A 池子**（六條件 + 戒律 + 淘汰），再加各字母自身條件。

---

## 字母 B：回後買上漲

**書本**：
- 5 步驟 位置 2「回後買上漲」
- 寶典 Part 11-1 位置 2 + 寶典 p.238-244 波浪型態戰法（「底底高 + 收盤站上MA5 → 買進」+ 9點提醒第2條）

**實作**：[lib/analysis/breakoutEntry.ts](../lib/analysis/breakoutEntry.ts) `pullback_buy`

**條件**（書本明確）：
1. `detectTrend === '多頭'`
2. 近 20 根內曾跌破 MA5（有「回」的證據）
3. 今日紅K + 實體 ≥ 2.5%
4. 今日量 ≥ 前日 × 1.3
5. 今日收盤站回 MA5
6. 今日收盤突破前根K高

**偏離**：
- ✅ 100% 對齊書本（2026-04-21 移除無書本出處的 KD 金叉 gate）
- 2026-05-10 commit af190d0：放量突破跨日 N≤3（容忍跨日，書本未量化）

---

## 字母 C：盤整突破

**書本**：5 步驟 位置 1 + 寶典 Part 11-1 位置 1
**實作**：[lib/analysis/breakoutEntry.ts](../lib/analysis/breakoutEntry.ts) `consolidation_breakout`

**條件**：
1. `detectTrend === '盤整'`（非多頭非空頭）
2. 突破兩 high pivots 連線延伸值（上頸線）
3. 紅K + 實體 ≥ 2.5%
4. 量 ≥ 前日 × 1.3

**偏離**：
- ✅ 100% 對齊書本（移除 10 根盤整 / 15% 振幅等自創）
- ⚠️ 軌道類訊號（M 已用 ×1.03 真突破）；C 是型態類，未套 ×3% padding

---

## 字母 D：一字底（反轉軌，下方詳述）→ 見「三、反轉軌」

> ⚠️ **歷史殘留**：實作位於 [lib/analysis/highWinRateEntry.ts](../lib/analysis/highWinRateEntry.ts) 的函數仍叫 `detectStrategyE`（原本 E=一字底，2026-04-20 重命名後沒改函數名）。讀 code 時注意對應關係。D 在反轉軌中描述，因為它不過 Step 1 池子。

---

## 字母 E：缺口進場（跳空上漲）

**書本**：5 步驟 p.40 位置 4「跳空上漲」
**實作**：[lib/analysis/gapEntry.ts](../lib/analysis/gapEntry.ts) `detectStrategyD`（函數名歷史殘留）

**條件**（全部必滿足）：
1. 開盤 > 前日最高（向上跳空）
2. 紅K（close > open）
3. 實體 ≥ 2.5%
4. 量 ≥ 前日 × 1.3

**特性**：多頭軌（必過 A 池子六條件+戒律+淘汰）

---

## 字母 J：ABC 突破（原 G）

**書本**：寶典 Part 11-1 位置 6 p.697 + Part 12-4 祕笈圖 #16 p.815
**實作**：[lib/analysis/abcBreakoutEntry.ts](../lib/analysis/abcBreakoutEntry.ts)

**書本原文**：
> 多頭上漲一波後，出現 A、B、C 的 3 波修正（形成短期空頭），反彈大量紅 K 突破下降切線，股價在月線（MA20）上時做多。

**條件**：
1. 過去（≥ 20 根）有過明確多頭上漲段（最高點顯著高於起點，≥ 8%）
2. 隨後 3 波修正（A 跌→B 反彈→C 跌；近期「頭頭低、底底低」短空結構）
3. 修正期間兩個高點（A 後反彈頂、B 後反彈頂）連線形成下降切線
4. 今日紅K實體 ≥ 2% + 量 ≥ 前日 × 1.3
5. 今日收盤突破下降切線今日延伸值
6. 今日收盤站上 MA20

**偏離**：
- ⚠️ MIN_PRIOR_RUN_PCT = 8%（「上漲一波」實作詮釋）
- ⚠️ MIN_CORRECTION_DROP_PCT = 3% + MIN_CORRECTION_SPAN_DAYS = 6（避免太淺/太快誤判，書本未量化）

---

## 字母 K：K 線橫盤突破（原 I）

**書本**：寶典 Part 11-1 位置 3 p.694 + Part 12-4 祕笈圖 #5 p.802
**實作**：[lib/analysis/klineConsolidationBreakout.ts](../lib/analysis/klineConsolidationBreakout.ts)

**書本原文**：
> 多頭中長紅 K 上漲後，股價維持在這根紅 K 上方「橫盤整理」，隨後再大量中長紅 K 突破橫盤最高點，做多。

**條件**：
1. 多頭趨勢中
2. 過去 5-15 根 K 線可找到一根「中長紅 K」當錨點（實體 ≥ 3%）
3. 從錨點次日到昨日，股價維持在錨點之上「橫盤」：
   - 期間最低 ≥ 錨點低點
   - 期間最高與錨點高的距離 < 5%（狹幅）
   - 至少 4 根 K（5 天起算）
4. 今日紅K實體 ≥ 2% + 量 ≥ 前日 × 1.3
5. 今日收盤突破橫盤期間最高點

**偏離**：
- ⚠️ KLINE_CONSOL_MIN/MAX_DAYS = 5-15（書本「橫盤一段」未量化）
- ⚠️ KLINE_CONSOL_ANCHOR_BODY_PCT = 3%（「中長紅」實作詮釋）
- ⚠️ KLINE_CONSOL_MAX_RANGE_PCT = 5%（「狹幅」實作詮釋）

**與 C 盤整突破差異**：
- C：一段較長盤整（detectTrend = 盤整）→ 突破上頸線
- K：短期狹幅橫盤（5-15 天，在中長紅 K 上方）→ 突破橫盤最高點

---

## 字母 L：過大量黑 K（原 H）

**書本**：寶典 Part 11-1 位置 8 p.699 + Part 12-4 祕笈圖 #9 p.806
**實作**：[lib/analysis/blackKBreakoutEntry.ts](../lib/analysis/blackKBreakoutEntry.ts)

**書本原文**：
> 多頭上漲一波後，大量黑 K 跌破前一日 K 線最低點，或跌破 MA5，隨即（3 日內）出現大量紅 K 突破大量黑 K 的最高點，做多。

**條件**：
1. 多頭趨勢中
2. 過去 3 日內出現「大量黑 K」：黑 K + 量 ≥ 前日 × 1.3 + (跌破前一日 K 低 OR 跌破 MA5)
3. 今日紅K實體 ≥ 2% + 量 ≥ 前日 × 1.3
4. 今日收盤突破大量黑 K 的最高點

**偏離**：
- ✅ MAX_DAYS_AFTER_BLACK_K = 3（書本明寫「3 日內」）
- ⚠️ BLACKK_MIN_BODY_PCT = 1.5%（「大量黑K」實體下限）
- ⚠️ BLACKK_MIN_VOL_RATIO = 1.3×（量門檻）

---

## 字母 M：突破上升軌道線

**書本**：寶典 Part 5 切線篇 p.387 + Part 12-4 祕笈圖 #18 p.~822
**實作**：[lib/analysis/v12LetterM.ts](../lib/analysis/v12LetterM.ts)

**書本原文**（p.387）：
> 多頭上漲時，上升切線是一條連接 2 低點的趨勢線，在連接 2 低點中間的上面高點，畫 1 條與上升切線平行的上升線，稱為「上升軌道線」，是一條壓力線。

**條件**：
1. 多頭趨勢
2. 找 2 個確認 pivot low（支撐切線）
3. 過 2 低點之間最高 K high，畫平行於支撐切線的軌道線
4. 收盤 ≥ 軌道線當日值 × 1.03（**×3% 真突破**）
5. 紅 K + 實體 ≥ 2% + 量 ≥ 1.3×

**偏離**：
- ✅ M 屬軌道類，套 ×3% 真突破（議題 6）
- ✅ 套 pivot gate（議題 47，同 BP）

---

## 字母 P：高檔拉回

**書本**：寶典 Part 11-1 第 3 位置 p.693「等拉回」
**實作**：[lib/analysis/v12LetterP.ts](../lib/analysis/v12LetterP.ts)

**書本原文**：
> 多頭連續上漲高檔，拉回不破前低，不破月線（MA20），再上漲時做多。

**條件**：
1. 多頭趨勢（detectTrend = 多頭）
2. 過去 N 天內有過上漲（≥ 5%），最近 1-2 天回檔（淺回）
3. 拉回最低點不破 MA20（2026-05-09 從 MA10 改 MA20，對齊書本「月線」原文）/ 不破前一個 pivot low
4. 今日紅 K（含漲停/跳空例外）+ 實體 ≥ 2% + 量 ≥ 1.3×
5. 收盤突破前一日（拉回最後一日）K 高

**與 B 回後買上漲差異**：
- B 等上漲（深回）：曾跌破 MA5 + 站回（回檔較深，已有結構性下跌）
- P 等拉回（淺回）：高檔回檔 1-2 天 + 不破 MA20（短時間小回）

**偏離**：
- ⚠️ MAX_PULLBACK_DAYS = 2（「等拉回」≤ 2 天，議題 5 拆分時自定）
- ⚠️ MIN_PRIOR_RUN_PCT = 5%（「連續上漲」實作詮釋）

---

# 三、反轉軌（D/F/N/O）

反轉軌字母**不過 A 池子的 Step 1 過濾**（書本「抓底/反轉」型態本就發生在空頭轉折時，多頭六條件未成立是正常）。

---

## 字母 D：一字底

**書本**：《抓住飆股》25 種型態 #9「一字底型態」
**實作**：[lib/analysis/highWinRateEntry.ts:100](../lib/analysis/highWinRateEntry.ts) `detectStrategyE`（函數名歷史殘留）

**6 步層層檢查**：
1. 當日紅K實體 > 2% + 收盤突破 MA5/MA10/MA20 三線
2. 往前找最長「滾動 20 天窗口收盤差 < 8%」盤整期 ≥ 40 天（書本「≥2個月」）
3. 收盤突破上頸線（盤整期最高收盤）
4. 盤整末 10 天至少 5 天均線糾結（MA5/10/20 spread < 3%）
5. 盤整期均量 < 前期 20 天均量 × 60%（量縮）
6. 當日量 ≥ 盤整期均量 × 2（爆量突破）

**偏離**：
- ✅ 40 天對齊《抓住飆股》「≥2個月」
- ✅ 突破量 ×2 對齊朱家泓爆量定義
- ❌ 8% 窄幅、60% 量縮、3% 糾結為實作自選（書本只寫「狹幅、極少」）— 第三類自創
- ❌ 120 天回看 lookback 完全自創（[bookThresholds.ts:96](../lib/analysis/bookThresholds.ts#L96)）

---

## 字母 F：V 型反轉

**書本**：朱家泓《K 線交易法》V 形反轉 4 條件 + 寶典 Part 12 祕笈圖#1「低檔大量長紅K反轉」+ 5 步驟 位置 6 + 《抓住飆股》p.316
**實作**：[lib/analysis/vReversalDetector.ts](../lib/analysis/vReversalDetector.ts)

**結構**：[連續下跌] → [變盤線止跌] → [止跌等待（不破變盤線低）] → [今日紅 K + 帶量 + 突破前 K 高]

**條件**（全部必滿足）：
1. **連續下跌**：變盤線之前 5 根下跌 ≥ 3 天 且 段首高 → 變盤線低 跌幅 ≥ 10%
2. **變盤線止跌**：過去 1-15 根內出現變盤線（十字 / 紡錘 / 長下影）
3. **止跌等待**：變盤線之後到今日前，最低不跌破變盤線 low
4. **紅 K + 帶量**：今日紅 K 且 量 ≥ 前 5 日均量 × 1.5（爆量 ×2 對齊朱家泓）
5. **突破前 K 高**：今日收盤 > 前一根 K 棒高點（含上影線）

**特性**：
- 不限大盤趨勢
- 不套戒律（書本 Part 3 K 線型態買法獨立）
- 判斷基準為收盤價

**注意**：函數命名上 v11 時期把 C 當 V 反轉，v12 後改為 F 字母。

---

## 字母 N：型態確認

**書本**：寶典 Part 11-1 第 7 位置「等型態確認」p.697 + 抓飆股 Part 7「25 種型態附錄」p.314-342 + 5 步驟 步驟 1 第 7 章 情況 5 p.110
**實作**：[lib/analysis/v12LetterN.ts](../lib/analysis/v12LetterN.ts)

**v12 階段 1 實作 3 個高達成率底部型態**：
- 頭肩底（達成率 83%）
- 三重底（達成率 95%）⭐ 最高
- 圓弧底（達成率 85%）

**v12 階段 2 補入**：
- 複式頭肩底 80% / 跌菱形 80% / 下降楔形 90% / 雙重底 36%

**2026-05-10 補入**：
- N 字底（A 高→B 低→C 突破 A 高）

**頂部型態**（向下跌破做空 / 出場警示）：頭肩頂 / 三重頂 / 雙重頂

**關鍵設計**：
- 議題 33：N 走 LockWatch（頸線突破時 detectTrend 通常還沒翻多 → 觀察階段 → 趨勢確認後升級進場）
- 議題 6：N 是型態類，套 ×3% + 3 天 provisional
- 議題 49：N 結構失效 = 跌破對應低點

**偏離（第三類自創）**：
- ❌ N padding ×1.20（突破過頭不視為進場，[v12LetterN.ts:225](../lib/analysis/v12LetterN.ts#L225)）
- ❌ N padding ×0.97（接近目標不視為進場，[v12LetterN.ts:233](../lib/analysis/v12LetterN.ts#L233)）

實務「過濾過頭已達標紀錄」需求，與書本「真突破 ×3%」概念衝突。詳見「附錄 D」。

---

## 字母 O：打底完成

**書本**：寶典 Part 11-1 第 1 位置「等打底完成」p.691 ⭐
**實作**：[lib/analysis/v12LetterO.ts](../lib/analysis/v12LetterO.ts)

**書本原文**：
> 空頭低檔大量盤整打底 + 反轉多頭確認 + 站上 MA20 + MA20 向上 + 大量紅 K 突破；同時站上 MA60 可做長多。

**條件**：
1. 過去趨勢為空頭，最近轉為盤整（detectTrend 軌跡：空頭 → 盤整）
2. 打底期間出現過大成交量（書本「大量打底」）
3. 今日 detectTrend 翻多（頭頭高底底高首次成立）
4. close ≥ MA20 + MA20 上揚
5. 紅 K ≥ 2% + 量 ≥ 1.3×
6. close 突破打底盤整期最高 K 高

**特性**：
- 議題 33：O 觸發即進場（要件已含「反轉多頭確認」）
- 議題 47：O 不套 pivot gate（自帶結構，剛翻多沒 pivot 對）
- 套 ×3% + 3 天 provisional（型態類）
- 站上 MA60 = 可做長多（書本加分項，記 `aboveMA60` flag）

**偏離**：
- ⚠️ MIN_BASE_DAYS = 10（「打底期至少 10 天」實作詮釋）

---

# 四、戰法軌（Q）

## 字母 Q：三條均線戰法

**書本依據**：抓住線圖 第 4 篇 第 8 章「穩健獲利密技：三條均線戰法」p.261-265 ⭐ 朱家泓本人「年獲利 1 倍」首選戰法

**實作**：[lib/analysis/v12LetterQ.ts](../lib/analysis/v12LetterQ.ts)

> ✅ **2026-05-22 二次審計排除衝突**：
> - rockstock Q 戰法用 **MA3 + MA10 + MA24**
> - 朱家泓免費體驗課 PDF p37「第三大金剛」官方均線是 **MA5/10/20/60**
> - 兩者**屬不同教學/戰法階段，無衝突**：經查《抓住線圖股民變股神》第 4 篇第 8 章 p.262 OCR 原文確認「採用3日均線及10日均線為操作進出依據。24日均線做為趨勢判定」。Q 戰法 code 與書本 p.262 完全一致（進場 / 出場 / 停損條件全部命中）。

**多頭做多 SOP**（書本 p.262）：
- 趨勢判定：股價在 MA24 之上 + MA24 向上
- 進場：MA3 + MA10 黃金交叉 + 股價站上 MA3
- 續抱：MA3 + MA10 沒死叉前
- 出場：收盤前確認 MA3 + MA10 死叉 + 股價跌破 MA3
- 停損：進場後守 MA10（書本 p.262 明寫）

**關鍵設計**：
- 議題 33/93：Q 觸發即進場（獨立軌不走 LockWatch）
- 議題 96/124（衝突 γ）：Q 戰法仍過 Step 0 大盤過濾
- 議題 96/125（衝突 δ）：Q 只用自己 SOP，Step 5 ②/③ 不強制
- v11/v12 互斥：用戶選 Q 戰法時不混用 v12 字母系統

**偏離**：
- 🔴 **2026-05-11 偏離**：Q 戰法軌跳過十大戒律 reject（commit 2698969）。書本未明寫，純實務決議。

---

# 五、機械軌（R）

## 字母 R：乖離率機械軌

> 🔴 **完全自創**（2026-05-21 用戶要求新增，commit b33fa2f）。**無書本依據**。

**實作**：[lib/strategy/StrategyConfig.ts:485-509](../lib/strategy/StrategyConfig.ts#L485) + [MarketScanner.ts](../lib/scanner/MarketScanner.ts) + [buyMethodTracks.ts:74](../lib/scanner/buyMethodTracks.ts#L74)

**邏輯**：
1. 成交額前 500 過濾
2. **跳過**六條件、戒律、淘汰法、Step 0 大盤過濾、MTF
3. 依 MA20 乖離率排序：
   - long：MA20 乖離負最多 top 10（超跌反彈候選）
   - short：MA20 乖離正最多 top 10（超漲回檔候選）

**性質**：
- 不過任何書本過濾
- 純機械式統計挑選
- ⚠️ **審計建議暫停評估**：尚未確認是否要納入正式軌道

詳見「附錄 D：偏離書本項目」 + [docs/audit/2026-05-22-knowledge-contamination-audit.md](audit/2026-05-22-knowledge-contamination-audit.md) 第三類規則。

---

# 六、Tier 1 三項對齊（2026-05-21）

**性質**：📭 **線上課程依據，未經書本筆記固化**

**commit**：669f273（feat(zhu): Tier 1 三項書本對齊）

| Tier 1 項目 | 規則 | code | 唯一依據 | 急迫性 |
|---|---|---|---|---|
| **MA20 斜率排序** | 多頭時，第三排序鍵 = MA20 5 日斜率 desc | [applyPanelFilter.ts:61-65](../lib/selection/applyPanelFilter.ts#L61) | 朱老師 CH3「均線三大力量」量化 | 🔴 高 |
| **弱中透強加持** | D/F 觸發時偵測「弱中透強」加分 | [MarketScanner.ts:1400-1432](../lib/scanner/MarketScanner.ts#L1400) | 朱老師 CH2-1（**林穎課程**，但 commit 標朱老師 — 來源混淆）| 🟡 中 |
| **接近壓力區位置** | close ≥ swingHi × (1-3%) 判定「接近壓力」 | [trendAnalysis.ts:498-517](../lib/analysis/trendAnalysis.ts#L498) | 2026-05-21 林穎 CH2 + 朱老師 CH3 | 🟡 中 |

**問題**：
- 三項都來自線上課程（朱老師 CH3 + 林穎 CH2）
- 無書本頁碼可對照
- 線上課 CH1-3 完整筆記尚未整理為 docs

**待辦**：
- T6: 整理線上課 CH1（朱老師：趨勢）筆記
- T7: 整理線上課 CH2（林穎：K 線）筆記
- T8: 整理線上課 CH3（朱老師：均線）筆記

---

# 七、停損停利（Step 3 / Step 5）

## 停損框架（Step 3）

**書本**：短線守則 p.41
**實作**：[lib/sell/v12StopLoss.ts](../lib/sell/v12StopLoss.ts)

| 規則 | 值 | 書本 | 偏離 |
|---|---|---|---|
| STOP_LOSS_RULE_PCT | 7% | 短線守則 p.41 | ✅ |
| F 停損 | ×7% | 書本明寫上限 | ✅ |
| Q 守 MA10 | — | 抓住線圖 p.262 | ✅ |
| 各字母 trailing MA | 不同 | 書本「操作三線」未細分到字母 | ⚠️ code 自選 |
| 各字母 fixedPct (5/7/10%) | 不同 | 書本只明寫 F=7% | ⚠️ code 自選 |
| 末升段 trailing | recentHigh × 0.97 | 書本「移動停利」未量化 | ⚠️ 0.97 自選 |

## 停利框架（Step 5）

**書本**：寶典 Part 11-1 p.701 + 5 步驟 步驟 5
**實作**：[lib/sell/v12TakeProfit.ts](../lib/sell/v12TakeProfit.ts) + [v12Operation.ts](../lib/sell/v12Operation.ts)

| 規則 | 內容 | 書本 | 偏離 |
|---|---|---|---|
| PROFIT_TARGET_RULE_PCT | 10% | 短線守則 p.41 | ✅ |
| ⑥-1 破盤整下緣強制出場 | — | 寶典 Part 11-1 p.701 | ✅ |
| ⑥-2 趨勢翻空強制出場 | — | 同上 | ✅ |
| ⑥-4 虧 10% 強制出場 | — | 同上 | ✅ |
| ⑥-5 結構破強制出場 | — | 同上 | ✅ |
| ⑤-② 切 MA5 | MA20 乖離 > `HIGH_DEVIATION_PCT` | 寶典 p.568 | 🔴 25% 偏離書本 15% |
| SELL-tp-pattern-target | 達型態目標價 | 5 步驟步驟 5 | ✅ |
| SELL-tp-3red-shadow | 連 3 紅 + 長上影 | 寶典 K 棒訊號 #7 | ✅ |
| SELL-tp-high-vol-black-20 | 獲利 20% 後黑K大量跌破前低 | 寶典 #8 急漲反轉 | ✅ |
| SELL-tp-reach-resist-2pct | 接近壓力 ±2% | 書本「接近壓力」未量化 | ❌ 2% padding 自創 |
| 超長線升級 30% | OP_SUPER_LONG_30 | 書本「達高檔」未量化 | ❌ 30% 自創 |

---

# 八、走圖輔助信號

## K 線型態

**書本**：寶典 Part 3 p.199-245 + 《抓住K線》
**實作**：[lib/analysis/klinePatterns.ts](../lib/analysis/klinePatterns.ts)

書本 Part 3 三類型態全部實作（18+ 函數）：

| 類型 | 型態 | 函數 |
|---|---|---|
| **變盤線**（單根警示）| 變盤紅K/黑K 槌子、倒槌 4 種 | `isHammer`、`isInvertedHammer` |
| **反轉型態（多）** | 晨星標準、孤島、母子、雙星、三星 5 變化 | `detectMorningStarVariants` |
| **反轉型態（多）** | 低檔長紅吞噬、強貫穿 | `isBullishEngulfing`、`isBullishPiercing` |
| **反轉型態（空）** | 高檔長黑吞噬、強覆蓋（烏雲罩頂） | `isBearishEngulfing`、`isStrongBearishCover` |
| **繼續型態（多）** | 上升三法、一星二陽、上漲連三紅 | `detectRisingThreeMethods`、`detectOneStarTwoYang`、`detectThreeRisingRed` |
| **繼續型態（空）** | 下降三法、一星二陰、下跌連三黑 | `detectFallingThreeMethods`、`detectOneStarTwoYin`、`detectThreeFallingBlack` |

## 切線突破警示

**書本**：寶典 p.37/p.38（明寫「警示非進出場」）
**實作**：[lib/analysis/trendlineAnalysis.ts](../lib/analysis/trendlineAnalysis.ts)

- 突破下降切線：空頭結構下股價突破 → 轉強警示
- 跌破上升切線：多頭結構下股價跌破 → 轉弱警示
- 急切線：視覺角度 > **60°**（網路通用，已對齊；原 0.5%/天自創已移除）

✅ 已正確分層：只畫在走圖上，不進選股邏輯

## 量價背離（chipDivergence）

**實作**：[lib/analysis/chipDivergence.ts](../lib/analysis/chipDivergence.ts)
**書本依據**：✅ **2026-05-22 已修正為「量價背離」**（不是法人籌碼）

> 📌 **檔名歷史殘留**：檔名 `chipDivergence` 來自 v11 時期想做「法人籌碼背離」，2026-05-22 審計後重寫為書本「量價背離」定義，與 entryProhibitions 戒律 3 共用同一書本門檻；檔名暫時保留以維持 import 相容。

**書本來源**（已對齊）：
- 寶典 p.57 戒律 3「量價背離 + KD 高檔 + 乖離過大」之背離部分
- 5 步驟 量價 13 條「沒有量能：上漲行進中量縮或量價背離」

**定義**（書本標準）：

| 訊號類型 | 條件 |
|---|---|
| **空頭背離**（頂部警示，動能衰竭）| 近 3 日價漲 > 5% + 今日量 < 昨日量 |
| **多頭背離**（底部訊號，賣壓衰竭）| 近 3 日價跌 > 5% + 今日量 < 昨日量 |

**使用範圍**：
- 僅在 `/api/stock/chips` 走圖頂部 banner 顯示
- **不**進入選股流程（選股的量價背離判定在 `entryProhibitions.ts` 戒律 3，共用同一門檻 `VOL_PRICE_DIVERGENCE_GAIN_PCT = 0.05`）

**偏離**：
- ⚠️ 5% 漲跌幅門檻為實作具體化（書本只說「量價背離」未量化），與 [entryProhibitions.ts:23](../lib/rules/entryProhibitions.ts#L23) 一致

---

# 九、Phase C 鎖股觀察（LockWatch）

**實作**：[features/lockwatch/](../features/lockwatch/) + [lib/scanner/](../lib/scanner/)

**設計**：N 型態類訊號（頸線突破時 detectTrend 通常還沒翻多）走 LockWatch 觀察階段，趨勢確認後升級進場。

**Phase C 過濾參數歷史**：

| 版本 | 過濾門檻 | commit |
|---|---|---|
| 原版 | close 接近頸線 ×0.95 / 70% | — |
| 🔄 **2026-05-11 偏離** | close 接近頸線 ×0.98 / 80%（**收緊**）| e813eee |
| 2026-05-11 加入「過頭」過濾 | close < target × 0.97 | 0fab0ae |
| 2026-05-11 鎖股觀察改成「即將突破」清單 | — | 7d3c0f9 |
| 2026-05-10 結構失效改真跌破門檻 | 頸線 × 0.97 / × 1.03 | dfbcaa5 |

---

# 十、篩選開關：MTF 長線保護短線

**書本**：5 步驟「長線保護短線」+ 朱家泓實例（伍豐 2015/3/16、宣德 2015/3/13）
**實作**：[lib/analysis/multiTimeframeFilter.ts](../lib/analysis/multiTimeframeFilter.ts)

**設計精神**：「把日線六條件套到週線再測一次」

### 週線 6 項 checklist（對齊日線六條件）

| # | 條件 | 角色 |
|---|---|---|
| ① | 週線趨勢多頭（頭頭高底底高）| Gate |
| ② | 週線 MA5/10/20 三線多排 + MA10/20 向上 | Gate |
| ③ | 週線收盤 > MA10 AND MA20 | Gate |
| ④ | 週量 ≥ 前週 × 1.3 | Gate |
| ⑤ | 週線紅K實體≥2% + 高收盤 + 上影≤實體 | Gate |
| ⑥ | MACD 綠縮或紅延 + KD 金叉 | 加分（非 gate）|

### 月線 1 項

| 條件 | 角色 |
|---|---|
| 月線趨勢不是空頭 | Warning（非 gate，寬鬆）|

**通過條件**：週線 ①-⑤ 全過 = MTF pass
**UI toggle**：可關閉整個 MTF

---

# 附錄 A：書本出處總覽

| 書 | 負責範圍 |
|---|---|
| **《活用技術分析寶典》**（主力）| 六條件 p.54 / 十大戒律 p.57-58 / 淘汰法 Part 10 p.659-662 / 高勝率 Part 12 p.749-755 / **8 種進場位置 Part 11-1 p.691-699（O/K/P/B/J/L）** / 波浪 p.22, 35 / 盤整 p.87 / 狹幅 p.299 / **切線 p.37-38 + Part 5 p.348-393（軌道線 p.387，字母 M）** / K 線型態 Part 3 p.199-245 / **18 種空轉多祕笈圖 Part 12-4 p.802-822（C/D/F/J/K/L/M）** / 強制出場 p.701 / 末升段 p.46-52 / 乖離 p.568 / 布林 p.574-581 / 黃金切割 p.472 / W底 M頭 p.475-479 / 整數關卡 p.480-481 / 紅K 支撐 p.462 / MACD p.540-547 / KD p.553-558 |
| **《做對5個實戰步驟》** | p.40 四個進場位置（B/C/E 字母）、長線保護短線概念、步驟 5 停利、p.110 情況 5（字母 N）、p.41 停損停利 |
| **《抓住飆股輕鬆賺》** | p.316 V 形底（字母 F）/ 25 種型態 p.314-342（字母 D/N）/ 爆量定義（前日×2）|
| **《抓住K線獲利無限》** | Part 3 K 線型態 p.224-235 / 第 7 篇 V 反轉（字母 F）|
| **《抓住線圖股民變股神》** | 戰法 1 MA5 波浪 + 長線保護短線 / **第 4 篇第 8 章 p.261-265 三條均線戰法（字母 Q）**⚠️ 與線上 PDF MA5/10/20/60 衝突 |
| **《學會走圖SOP》（林穎）** | MA + KD + MACD 指標參考 |
| **線上課 CH1-3**（PDF 73 頁 + 影音）| Tier 1 三項對齊（朱老師 CH3 均線 / 林穎 CH2 K線 / 朱老師 CH3 接近壓力區）⚠️ **筆記未固化** |

---

# 附錄 B：朱家泓「大量」兩種定義（重要）

| 概念 | 倍數 | 用途 | 出處 |
|---|---|---|---|
| **攻擊量（進場）** | 前日 × **1.3** | 六條件 ④、戒律 9、V 反轉、B/C/E/J/K/L/M/O/P 共同扳機 | 寶典 p.54 ④ |
| **爆量（主力動作）** | 前日 × **2** | R9「爆量不漲」、D 一字底突破量、V 反轉爆量 | 《抓住飆股》+ 理財達人秀 YouTube #17 |

**⚠️ 兩個概念不同，不可混用。**

---

# 附錄 C：書本對齊度分類

## ✅ 完全照書本

- 六條件 ①-⑥（除 ⑥ KD 向下偏離見附錄 D）
- 十大戒律 1-10（戒律 3 乖離 25% 偏離見附錄 D；戒律 11 已移除）
- 淘汰 R1/R2/R5/R6/R7/R9（執行方式「警示不擋」偏離見附錄 D；R3/R8/R10/R11 已移除）
- 高勝率位置 1/2/3/5/6
- 字母 B 回後買上漲
- 字母 C 盤整突破
- 字母 E 缺口
- 字母 F V 反轉
- 字母 J ABC 突破
- 字母 K K 線橫盤
- 字母 L 過大量黑 K
- 字母 M 突破上升軌道線
- 字母 O 打底完成
- 字母 P 高檔拉回（不破 MA20 對齊書本「不破月線」）
- MTF 週線六條件 checklist
- K 線型態 18+ 函數
- 停損 7% / 停利 10%
- 強制出場 ⑥-1/-2/-4/-5
- 布林 8 大買賣訊、3 軌同向
- 切線、黃金切割、W底 M頭、整數關卡
- MACD/KD 全部型態
- 末升段 3 訊號

## ⚠️ 書本模糊 → 實作具體化（加 JSDoc 標記）

- 三線聚合 spread < 3%（位置 4 糾結）
- 盤整狹幅 < 15%
- 量價背離「漲>5%」
- 週線壓力 3% 距離
- R4 量縮 0.5×（市場通用）
- R6 壓力長黑次數 ≥ 2 次
- R9 漲幅 < 3%
- 三/雙重底容差 5%
- 楔形 1.2 倍
- 末升段乖離 > 15%
- 各字母 trailing MA / fixedPct（書本未細分到字母）
- 末升段 trailing × 0.97
- 切線觸碰 ±2%
- 整數關卡近 1%
- 布林平行寬度差 < 10%
- 字母 J MIN_PRIOR_RUN_PCT = 8% / MIN_CORRECTION_DROP_PCT = 3% / SPAN_DAYS = 6
- 字母 K KLINE_CONSOL_MIN/MAX_DAYS = 5-15 / ANCHOR_BODY = 3% / MAX_RANGE = 5%
- 字母 L BLACKK_MIN_BODY_PCT = 1.5%
- 字母 O MIN_BASE_DAYS = 10
- 字母 P MAX_PULLBACK_DAYS = 2 / MIN_PRIOR_RUN_PCT = 5%
- V 反轉「前 10 根 ≥3 黑K」

## ❌ 完全自創（書本+朱家泓網路均無，已加 JSDoc）

- 字母 D 一字底 8% 窄幅
- 字母 D 一字底 60% 量縮
- 字母 D 一字底 120 天 lookback
- 字母 N padding ×1.20（突破過頭）
- 字母 N padding ×0.97（接近目標）
- 字母 R 乖離率機械軌（**完全自創**，跳過所有過濾）
- chipDivergence.ts 全部 5 條規則（**無書本標記**）
- MA20 乖離警示 12%（[bookThresholds.ts:98](../lib/analysis/bookThresholds.ts#L98)）
- 排序主鍵 changePercent desc（[applyPanelFilter.ts:57](../lib/selection/applyPanelFilter.ts#L57)，2026-04-19 回測驅動非書本）
- 停利「接近壓力 ±2%」padding
- 超長線升級 30%
- 攻擊量「新鮮信號」過濾（前 2 日不可連續大量上漲）
- 軌道線最少間隔 5 天
- 顯示用 13 條 thresholds（AI 信心、勝率色階、籌碼分級等）

## 📭 資料不足

- 字母 Q MA3/10/24（與線上 PDF MA5/10/20/60 衝突，書本頁碼待確認）
- Tier 1 三項對齊（朱老師 CH3 / 林穎 CH2，課程筆記未固化）
- 再進場規則（「書本戰法 1 波浪 / 戰法 4 二條均線」，無頁碼）

## 已移除的自創

- ~~10 天<15% 打底檢查~~（位置 1）
- ~~0.98 容差~~（位置 2）
- ~~前 10 日 max high 上頸線~~（位置 3）
- ~~回到盤整內~~（位置 6）
- ~~前 3-5 天 ≥2 紅K~~（位置 5）
- ~~近 5 天有黑K~~（位置 2）
- ~~10 天時序檢查~~（戒律 5）
- ~~15% 振幅+10 根+MA5 走平~~（戒律 7）
- ~~MA 開口 10%~~（戒律 3）
- ~~近 10 天跌破 MA5~~（B pullback_buy）
- ~~回檔 3-15 天 / ≥3%~~（B pullback_buy）
- ~~KD 金叉~~（B pullback_buy，2026-04-21 移除）
- ~~10 根盤整 / 15%~~（B 盤整突破）
- ~~40 天要求~~（高勝率位置 4）
- ~~R3/R8/R10/R11~~
- ~~戒律 11（上升切線）~~
- ~~0.5%/天急切線~~（改角度 > 60°）

---

# 附錄 D：偏離書本項目（第五類 🔄 已偏離）

git 歷史顯示這些規則原本對齊書本，後來使用者主動修改偏離。本附錄分兩部分：

## D.1 ✅ 已於 2026-05-22 回滾（對齊書本）

以下偏離項已於 2026-05-22 審計後回滾為書本原文，code 內保留 `// 2026-05-22 回滾` 註解供 audit 追溯：

| # | rule_id | 規則 | code | 書本原文 | 回滾現況 | 偏離 commit / 回滾說明 |
|---|---|---|---|---|---|---|
| ✅ 1 | **HIGH_DEVIATION_PCT** | MA20 乖離上限 | [bookThresholds.ts:142](../lib/analysis/bookThresholds.ts#L142) | 書本 p.568 = 15% | **0.15**（書本值）| 偏離 496309e（2026-05-20 改 25%）→ 2026-05-22 回滾 |
| ✅ 2 | **R-warn-not-block** | 淘汰法執行方式 | [MarketScanner.ts:493-497](../lib/scanner/MarketScanner.ts#L493) | 書本「立即出場」 | **hard gate**（`if (eliminated) return null`）| 偏離 496309e → 2026-05-22 回滾；實測 TW -12.3%、CN -5.1%，仍剩 161/230 檔可選，無 pool 飢餓 |
| ✅ 3 | **KD-declining-warn** | KD 向下不買 gate | [MarketScanner.ts:471-477](../lib/scanner/MarketScanner.ts#L471) | 書本短線規則 #9 | **hard gate**（`kdDecliningFilter`，K 下降即擋）| 偏離 496309e → 2026-05-22 回滾；可由 `kdDecliningFilter: false` 關閉 |
| ✅ 4 | **PROHIB-3 deviation 25** | 戒律 3 乖離門檻 | [entryProhibitions.ts:96](../lib/rules/entryProhibitions.ts#L96) | 書本只說「乖離過大」，原 docs 標 15% | **與 HIGH_DEVIATION_PCT 連動回 15%** | 隨 HIGH_DEVIATION_PCT 一起回滾 |
| ✅ 5 | **ZHU-PURE-BOOK devMax** | A 策略 devMax | [StrategyConfig.ts:200](../lib/strategy/StrategyConfig.ts#L200) | 「ZHU_PURE_BOOK」應 100% 書本 | **15%** | 隨 HIGH_DEVIATION_PCT 一起回滾 |

回滾影響量測：[docs/audit/2026-05-22-elimination-hard-gate-impact.md](audit/2026-05-22-elimination-hard-gate-impact.md)

## D.2 🔴 仍偏離書本（待裁決）

| # | rule_id | 規則 | code | 書本原文 | 現況 | commit |
|---|---|---|---|---|---|---|
| 🔴 1 | **Phase-C-ratio-098** | LockWatch Phase C 過濾 close 接近頸線 | [features/lockwatch/](../features/lockwatch/) | 原 ×0.95 / 70% | **×0.98 / 80%** | e813eee（2026-05-11） |
| 🔴 2 | **Q-no-prohibitions** | Q 戰法軌移除戒律 reject | [scanner/...](../lib/scanner/) | 書本 Q 戰法未明寫「不適用戒律」 | **跳過戒律** | 2698969（2026-05-11） |
| 🔴 3 | **N-padding-12-097** | N 突破過頭 / 接近目標 padding | [v12LetterN.ts:225-235](../lib/analysis/v12LetterN.ts#L225) | 書本「真突破 ×3%」 | **新增 padding** | 21d659e（2026-05-11） |
| 🔴 4 | **R-mechanical-track** | R 軌乖離率機械排名 | [StrategyConfig.ts:485](../lib/strategy/StrategyConfig.ts#L485) / [buyMethodTracks.ts:74](../lib/scanner/buyMethodTracks.ts#L74) | **完全自創**（跳過六條件 / 戒律 / 淘汰 / Step 0 / MTF）| **完全自創新軌道**，審計建議暫停 | b33fa2f（2026-05-21） |

## D.3 剩餘 D.2 偏離項的回滾方案

### 🔄 回滾 A：LockWatch Phase C 收緊參數回到 ×0.95 / 70%

- 改動：[features/lockwatch/](../features/lockwatch/)（具體位置待查）
- 影響：鎖股觀察清單範圍變寬
- 風險：低（LockWatch 是輔助觀察，不影響選股）

### 🔄 回滾 B：Q 戰法恢復戒律 reject

- 影響：Q 戰法觸發頻率下降
- 連動：書本 p.262 本意未明確「Q 不適用戒律」，回滾可能更安全

### 🔄 回滾 C：N padding（×1.20 / ×0.97）移除

- 改動：[lib/analysis/v12LetterN.ts:225-235](../lib/analysis/v12LetterN.ts#L225)
- 影響：N 字母信號更頻繁
- 評估：commit message 標「過濾過頭已達標紀錄」是實務需求，移除前需確認

### 🔄 回滾 D：R 軌（機械乖離率排名）暫停或移除

- 改動：[lib/scanner/buyMethodTracks.ts:74](../lib/scanner/buyMethodTracks.ts#L74) 將 R 從機械軌名單移除
- 影響：R 字母信號完全消失
- 評估：完全自創、跳過所有過濾，**審計建議暫停評估**直到確認是否要納入正式軌道

---

# 附錄 E：資料不足項目（第四類 📭）

這些規則依據「網路課程」「Podcast」「YouTube」「線上課 CH1-3」，沒有完整書本對照。**約 15 條**。

## E.1 Q 戰法三均線（MA3/10/24 vs MA5/10/20/60）

**問題**：
- rockstock Q 戰法用 **MA3 + MA10 + MA24**（code [v12LetterQ.ts:65](../lib/analysis/v12LetterQ.ts#L65)）
- 朱家泓**免費體驗課 PDF**（73 頁，p37 第三大金剛）官方均線是 **MA5/10/20/60**
- 兩者**不一致**
- 唯一書本依據是《抓住線圖股民變股神》第 4 篇第 8 章 p.261-265，但本次審計沒有讀到該書原文

**待辦 T5**：請使用者掃描或翻拍 p.261-265 確認三均線是哪三條。若書本是 MA3/10/24 則 code 正確；若是其他則需修正。

## E.2 Tier 1 三項對齊

| 項目 | 唯一依據 |
|---|---|
| MA20 斜率排序 | 朱老師 CH3「均線三大力量」量化 |
| 弱中透強加持 | 朱老師 CH2-1（**林穎課程，但 commit 標朱老師** — 來源混淆）|
| 接近壓力區 close ≥ swingHi × (1-3%) | 2026-05-21 林穎 CH2 + 朱老師 CH3 |

**待辦**：
- T6: 整理線上課 CH1（朱老師：趨勢）筆記 → `docs/zhu_online_course_ch1.md`
- T7: 整理線上課 CH2（林穎：K 線）筆記 → `docs/zhu_online_course_ch2.md`
- T8: 整理線上課 CH3（朱老師：均線）筆記 → `docs/zhu_online_course_ch3.md`

## E.3 其他

| rule_id | 規則 | 依據 |
|---|---|---|
| PROHIB-big-vol-mult-2 | 戒律 9 爆量 ×2 定義 | 朱家泓《抓住飆股》+ 理財達人秀 YouTube #17（🟢 已標明）|
| F-vrev-shape | V 反轉變盤線型態 | 朱家泓《K 線交易法》（書名存在，docs 未找到對應頁碼）|
| REENTRY-config | 再進場規則 trigger=ma5/ma10 停損 + maxBars=10 + 重新站上均線 + 量 ≥ 5MA × 0.8 | 「書本戰法 1 波浪 / 戰法 4 二條均線」（無頁碼）|

---

# 版本記錄

| 日期 | 修改 | 記憶檔 / commit |
|---|---|---|
| 2026-05-22 | **全文擴展**：補齊 v12 字母軌道（J/K/L/M/N/O/P/Q/R）+ 軌道架構 + 第五類偏離項標紅 + 資料不足章節 + Tier 1 對齊 + Phase C + 停損停利 v12 | 本次更新（依 docs/audit/2026-05-22-knowledge-contamination-audit.md）|
| 2026-05-21 | Tier 1 三項對齊：MA20 斜率排序 + 弱中透強 + 接近壓力區 | 669f273 |
| 2026-05-21 | R 軌乖離率機械軌新增 | b33fa2f |
| 2026-05-20 | 乖離 15% → 25%、KD 向下不擋、淘汰法警示不擋 | 496309e |
| 2026-05-13 | ABCDE D-medium：6 個自創常數搬 bookThresholds | e23962d |
| 2026-05-11 | Q 戰法軌移除戒律 reject | 2698969 |
| 2026-05-11 | LockWatch 過濾「突破過頭」(×1.20) | 21d659e |
| 2026-05-11 | Phase C close < target × 0.97 過濾 | 0fab0ae |
| 2026-05-11 | Phase C 過濾收緊 ×0.95→×0.98 / 70%→80% | e813eee |
| 2026-05-10 | 鎖股觀察改成「即將突破」清單 | 7d3c0f9 |
| 2026-05-10 | 結構失效改用真跌破門檻（頸線×0.97 / ×1.03） | dfbcaa5 |
| 2026-05-10 | 策略 B 站回 MA5 → 放量突破跨日 N≤3 | af190d0 |
| 2026-05-09 | v12 五步法全面對齊書本 + LockWatch UX | fa989bd |
| 2026-05-09 | v12 LockWatch 儲存層 + API + UI | 1681bb9 |
| 2026-05-09 | v12 round-2 audit — F vBottom + LockWatch | e86bf8e |
| 2026-05-09 | v12 8 audit bugs — deviation gate / abs stop / provisional | 1c94c41 |
| 2026-05-08 | v12 Phase 1.9/1.10/1.11 操作 + 停利 + 出場路徑分流 | 390cd3c |
| 2026-05-08 | v12 Phase 1.6/1.7/1.8 LockWatch + Provisional + Step 3 停損 | b6b24ad |
| 2026-05-08 | v12 Phase 1.4B 5 個新訊號 detector（M/N/O/P/Q） | a60a259 |
| 2026-05-08 | v12 Phase 1.4A 字母 mapping J/K/L | 9d0f56f |
| 2026-05-08 | v12 Phase 1.3 訊號 Gate Helpers | 230c941 |
| 2026-05-08 | v12 Phase 1.2 純書本條件 helpers | 078b1ad |
| 2026-05-08 | v12 Phase 1.1 Step 0 大盤過濾 | 99bd8da |
| 2026-05-08 | v12 Phase 0.2 共用 helpers + 完整規格文件 | 8d4f31a |
| 2026-04-21 | B pullback_buy 修正：移除 KD 金叉（無書本出處）、加入「近20根內曾跌破MA5」確認有回後；書本來源改寶典 p.238-244 波浪型態戰法 | `project_pullback_buy_no_ma5_breach_check.md` |
| 2026-04-20 | 整體重寫對齊書本（20+ 項改動）| 下列所有 |
| 2026-04-20 | 高勝率全面 4 線多排（MA60）| `project_book_5_fixes_done_0420.md` |
| 2026-04-20 | 戒律 3 改 3 項、移除 MA 開口自創 | `project_prohibitions_345_7_simplified_0420.md` |
| 2026-04-20 | 戒律 4 只看週線最近一個頭 | 同上 |
| 2026-04-20 | 戒律 5 簡化 `close < MA20` | 同上 |
| 2026-04-20 | 戒律 6/7 改 0 容差 + detectTrend 判定 | `project_book_alignment_4_fixes_0420.md` |
| 2026-04-20 | 戒律 8 改為空頭反彈（原誤裝 R8）| `project_book_5_fixes_done_0420.md` |
| 2026-04-20 | 戒律 9 從 ×1.5 改 ×2（爆量定義）| `project_book_8_more_fixes_0420.md` |
| 2026-04-20 | 戒律 11 新增上升切線不破 | `project_book_5_fixes_done_0420.md` |
| 2026-04-20 | 淘汰法改「任一即踢」、移除 R8/R10/R11 | `project_elimination_any_one_fires_0420.md` |
| 2026-04-20 | 高勝率位置 1 最終版用 detectTrend 多頭 | `project_high_win_positions_book_images_0420.md` |
| 2026-04-20 | 位置 2 用 findPivots 判底底低 + 移除自創補強 | 同上 |
| 2026-04-20 | 位置 3 上頸線用 findPivots 兩頭連線 | 同上 |
| 2026-04-20 | 位置 4 移除 40 天要求（與 F 策略區分）| `project_position4_vs_f_strategy_separation_0420.md` |
| 2026-04-20 | 位置 5 加「黑K大量」、移除「前3-5天≥2紅K」自創 | `project_high_win_positions_book_images_0420.md` |
| 2026-04-20 | 位置 6 改用兩頭兩底 findPivots + 突破上頸線 | 同上 |
| 2026-04-20 | B pullback_buy 重寫：detectTrend 多頭 + 站上 MA5 + KD 金叉 | `project_pullback_buy_book_rewrite_0420.md` + `project_b_strategy_detecttrend_0420.md` |
| 2026-04-20 | B 盤整突破：detectTrend 盤整 + findPivots 兩頭連線 | `project_b_strategy_detecttrend_0420.md` |
| 2026-04-20 | V 反轉黑K 5→3、量 ×1.3→×2 | `project_book_8_more_fixes_0420.md` |
| 2026-04-20 | F 一字底突破量 ×1.3→×2 | 同上 |
| 2026-04-20 | MTF 重寫為週線版六條件 | `project_mtf_rewrite_weekly_six_conditions_0420.md` |
| 2026-04-20 | findBuyPoints/candidateCollector 上影線對齊書本 | `project_upper_shadow_50pct_fix_0420.md` |
| 2026-04-20 | 切線急斜率改角度 > 60° | `project_trendline_angle_and_doc_rewrite_0420.md` |
| 2026-04-20 | 移除戒律 11（原始上升切線）+ R3（趨勢不明確）| `project_remove_prohibition11_r3_0420.md` |
| 2026-04-20 | 策略 F→E、E→D 命名重整（移除 F，字母連續）| `project_linter_strategy_rename_conflict_0420.md` |
