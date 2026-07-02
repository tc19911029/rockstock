# v12 vs 線上課程缺口追蹤清單

**來源**：`~/Desktop/朱家泓課程/筆記/99-V12差異報告.md`（2026-05-21 用戶手寫 + Claude Code Explore Agent 逐檔審查）
**最後同步**：2026-06-04（CH4 成交量 + CH5 選股 課程上線，新增 §F；CH1-3 缺口重驗）
**審查對象**：rockstock v12 codebase
**審查方法**：逐檔讀 11 個核心檔案 + grep 跨檔驗證，比對 40 個候選項
**CH4/CH5 課程知識文件**：[zhu_online_course_ch4.md](../zhu_online_course_ch4.md)（成交量）、[zhu_online_course_ch5.md](../zhu_online_course_ch5.md)（選股）

---

## 摘要

| 分類 | 計數 | 結論 |
|------|------|------|
| 🔴 真缺漏（A） | 8 項 | 概念性偵測器完全缺失 |
| 🟡 參數不對齊（B） | 5 項 | 實作存在但門檻偏低或未完全實現 |
| 🟢 已實作正確（C） | 27 項 | 驗證對齊書本/課程 |

**核心發現**：
- ✅ 葛蘭碧 8 條全實作，K 線組合模式豐富
- ✅ 轉折波、多時間框架分析已具備
- ⚠️ 幾項心法類偵測器（弱中透強、誘多警訊）尚未實作（部分已由 commit 669f273 補）
- ⚠️ MA 斜率/角度作排序維度（已由 commit 669f273 Tier 1 補）

> **2026-06-04 更新**：§A/§B/§C 為 CH1-3（趨勢/K線/均線）原始審查（8 真缺漏 + 5 參數不對齊 + 27 已實作）。
> CH4 成交量 + CH5 選股 上線後新增 **§F**（CH4 4 項 + CH5 5 項缺口 + CH1-3 13 項重驗）。CH1-3 重驗結果：MA 斜率排序、接近壓力區、強中透弱、紅黑配/黑紅配皆已補齊 live；仍缺 5 項（扣抵預測、該漲不漲、6.5% 長紅、中棒分級、葛蘭碧買 4 乖離對稱）。

---

## 一覽：CH1-5 vs v12（一樣 / 不一樣 / 要改）

> 全課程 5 章（CH1 趨勢 / CH2 K線 / CH3 均線 / CH4 成交量 / CH5 選股，**無 CH6**）對 v12 的逐章總結。細節見下方 §A-§F。
> 🛠️ **要動手改 v12 的執行計畫**（分 4 批 + 驗證步驟）見 [v12-course-improvements-plan.md](v12-course-improvements-plan.md)。

### CH1 趨勢（朱家泓）
- ✅ **一樣**：轉折波 `findPivots`、頭頭高底底高 / 頭頭低底底低、多空盤整三分、收盤判定、月線向上濾網（六條件③）、守 5 均出場、B 回後買上漲 / C 盤整突破。
- ⚠️ **不一樣**：「跌破月線 3 天內拉回 = 助漲」的 3 天時間窗未強制；趨勢改變三步法（破月線→破前低→破頸線）無分級出場警示。
- 🔧 **要改**：無急迫（低優先）。

### CH2 K線（林穎）
- ✅ **一樣**：十字 Doji(<0.5%)、三根 K 反轉（晨星/夜星）、紅黑配（吞噬/覆蓋/貫穿）、變盤線；強中透弱（高檔）已 live；紅黑配/黑紅配已補滿 8+6 條。
- ⚠️ **不一樣**：長紅/長黑用 2%（進場標準）非 6.5%（絕對多方最強）；缺中棒 3.5~6.5% 分級；遭遇線缺（一日封口有）；「該漲不漲」無機械 detector；變盤線「次日確認」只套型態軌；低檔弱中透強只有 util 未包 live rule。
- 🔧 **要改**：中棒分級 + 6.5% 平行版、遭遇線 detector、該漲不漲 detector、變盤線次日確認 flag。

### CH3 均線（朱家泓）
- ✅ **一樣**：MA5/10/20/60、多空排列、黃金/死亡交叉、均線糾結、葛蘭碧 8 法則全實作、**MA20 斜率排序已補**、**接近壓力區已補**、月線濾網。
- ⚠️ **不一樣**：葛蘭碧買 4 乖離 −10%（賣 8 +15%）不對稱，書本對稱 ±15%；扣抵預測 `daysUntilMaTurn` 缺。
- 🔧 **要改**：葛蘭碧買 4 −10%→−15%（易）、扣抵預測（中）。

### CH4 成交量（朱家泓）
- ✅ **一樣**：9 種量 `classifyVolume`、量價背離 3 型、窒息/凹洞量、高檔爆量 3 型、淘汰 R4/R9、**爆大量 ×2 對齊**、末升段暴量訊號。
- ⚠️ **不一樣**：攻擊量基準「前日 ×1.3」vs 課程「5 日均量 ×1.2~1.3」（倍數對齊、低優先）；草叢量/黃金右腳未進主掃描；末升段「5 訊號任 2」vs「三條件同時」；起漲紅 K 最低點「生死線」缺；逃命波缺；空頭續跌量分級缺。
- 🔧 **要改**：起漲生死線 detector（中）、末升段收嚴、草叢量是否進掃描（待回測）。

### CH5 選股（朱家泓）
- ✅ **一樣**：六條件 = 六六大順（內容全對應）、**獵兔 8 分類 = 字母 O/C/P/B/K/J/N/L（1:1）**、淘汰法核心 7 條、底部 O 打底 / N 型態、MTF 週線 gate、排序 `panelSortCompare`、LockWatch（F/N）。
- ⚠️ **不一樣**：六步驟「順序短路」vs v12 同時算 + 位置/均線次序對調；指標課程第 6 步 vs v12 加分（書本 6 全齊、rockstock 放寬 5/6）；universe 無「量過低 / 價<5 元」硬篩；底部圖形③（反彈突破月線橫盤）無 detector；強勢飆股無專屬法；淘汰⑬法人賣超（R8 移除）/⑮基本面沒技術面（範圍外）；淘汰⑦長期打底未破壓力缺。
- 🔧 **要改**：價<5 元硬篩（易、低衝擊）、底部③ detector、長期打底 detector、強勢飆股「第一波前提」、鎖股時序排序。

### 跨章「要改」優先序（全屬選股 code、動前須過 `scan-parity` 合約測試 + 三方同步）
- **易做、書本明確**：葛蘭碧買 4 乖離 −15% 對稱；中棒 3.5~6.5% 分級 + 6.5% 長紅平行版；價<5 元 universe 硬篩（低衝擊）。
- **中、有 alpha 潛力（需回測）**：起漲紅 K 生死線（假突破過濾）；末升段三條件收嚴；長期打底未破壓力淘汰；強勢飆股第一波前提。
- **清理（非選股邏輯）**：`klinePatterns.ts` dead-code；爆量門檻三處（1.8× / avg20×2 / avg5×1.5）統一；低檔弱中透強包 live rule。
- **資料/架構**：法人賣超淘汰（接 TWSE/FinMind 法人買賣超可復活）；持久化跨日鎖股資料庫（架構級，暫不動）。

---

## A. 真缺漏（8 項，🔴）

| 99 報告編號 | 項目 | 課程/書本出處 | 當前 code 狀態 | commit 669f273 是否已補 | 建議行動 |
|---|---|---|---|---|---|
| **B4** | `maPivot.daysUntilMaTurn()` MA 上彎/下彎預測函式 | 朱老師 CH3-2 移動扣抵 | `maPivot.ts` 只有 pivot 識別，無預測 | ❌ 未補 | 新增 `daysUntilMaTurn(period, prices)` 用扣抵價反推 |
| **B9** | MA 斜率/角度暴露為排序維度 | 朱老師 CH3-3 均線三大力量 | `trendSlope()` 存在但未用於 `applyPanelFilter` 排序；僅按漲幅+六條件分 | ⚠️ **部分補**（Tier 1 #1：MA20 斜率排序） | 確認 commit 669f273 是否完整覆蓋 `applyPanelFilter.ts:54-67` |
| **C1** | 弱中透強 / 強中透弱 detector | 林穎 CH2-2 K 線本身強弱改變 | 無「紅 K 但低收 / 低開高收」vs「黑 K 但高收 / 高開低收」偵測 | ⚠️ **部分補**（Tier 1 #2：弱中透強加持，commit 標朱老師但實為林穎，**來源混淆**）| 確認 commit 669f273 detector 在哪個檔，是否含「強中透弱」對稱版 |
| **C2** | 該漲不漲 / 直漲 detector | 林穎反覆強調 | 未實作「站上條件後 N 根無進展則出場」的機械式 detector | ❌ 未補 | 新增 `smartKLineRules.ts` 規則：紅 K 後 ≥3 根無新高即警示 |
| **C4** | 遭遇線 / 一日封口 detector | 林穎 CH2-6/CH2-7 | 未找到「前日缺口日內被補」型態的偵測 | ❌ 未補 | 新增 `klinePatterns.ts` 規則：缺口開盤 → 日內補滿 |
| **C9 細項** | 接近壓力區 metadata | 朱老師 CH3 + 林穎 CH2-2 | TrendPosition 有基本標籤但無「接近壓力」細分 | ✅ **已補**（Tier 1 #3：close ≥ swingHi × (1-3%)） | 已完成；複核：commit 669f273 已加 `detectPressureZone()` |
| **C10** | 次日確認延遲機制 | 林穎反覆強調「變盤線次日才算」 | 未看到「detector 觸發後待隔日開盤確認」的機制 | ❌ 未補 | 新增 detector 後處理層：變盤線型態打 `requiresNextDayConfirmation` flag |
| **C13** | MA 角度作排序維度 | 朱老師 CH3-3 | 同 B9（重複項） | ✅ **已補**（與 B9 連動） | 與 B9 同處置 |

---

## B. 參數不對齊（5 項，🟡）

| 99 報告編號 | 項目 | 課程值 | code 現值 | 證據 | 建議 |
|---|---|---|---|---|---|
| **A1** | 長紅 K 閾值 | 課程 CH2-4 **≥6.5%**（絕對多方最強）| **>=2%** | `ruleUtils.ts:10` `isLongRedCandle()` | **不一定要改**：書本寶典 p51-100「進場 K 線」也是 2%，課程 6.5% 是「絕對多方」概念，與「進場標準」是兩個概念。建議新增 `isMaxBullishCandle()` (≥6.5%) 平行存在 |
| **A2** | 長黑 K 閾值 | 課程 **≥6.5%** | **>=2%** | `ruleUtils.ts:14` `isLongBlackCandle()` | 同 A1，建議新增 `isMaxBearishCandle()` (≥6.5%) |
| **A4** | 中紅/中黑/小紅/小黑分級 | 課程明確 **6.5% / 3.5% / <3.5%** 三級 | 僅小/中長二分（缺 3.5-6.5% 中等級） | `ruleUtils.ts:59,106-112` `isSmallCandle(<1.5%)`, `isMedLongRed(>=2%)` | 新增中棒分級（`isMediumRed/Black(>=3.5% && <6.5%)`），對齊課程三級制 |
| **A6** | 葛蘭碧乖離門檻 | 課程 **±15%**（對稱） | 買 4 **-10%**、賣 8 **+15%**（不對稱、買方偏寬）| `granvilleRules.ts:173,324` | 將買 4 門檻從 -10% 收回 -15%，對齊課程對稱原則。**注意**：書本兩處皆 ±15%，目前 code 偏離書本 |
| **A9** | 多頭高檔 / 空頭低檔判定 | 課程 CH2「漲一倍/跌一半」**倍數概念** | `isHighPosition()` 用 MA20 ±10% 或 20 日漲幅 >30% | `ruleUtils.ts:274-288` | 增加「倍數版」判定：`isAfterDouble()`（漲幅 ≥100%）/ `isAfterHalf()`（跌幅 ≥50%），用於高/低檔出貨/進貨訊號 |

---

## C. 已實作正確（27 項，🟢）

### C.1 K 線基礎（A 章）

- **A3** 十字線（Doji）— `ruleUtils.ts:64` `isDoji() < 0.5%`（精確對齊書本）
- **A5** K 線橫盤 ≥4 根 — `klineConsolidationBreakout.ts:45` MIN/MAX = 4-15（對齊書本）
- **A7** 葛蘭碧法則 7 時間窗 — `granvilleRules.ts:286-295`（邏輯為「反彈靠近 MA 但未突破」）
- **A8** 回後買三條件 — `buyMethodTracks.ts:147` B 軌（紅 K + 量增 + 過昨高）
- **A10** 均線糾結門檻 — `bookThresholds.ts:89-92` 3% / 15%（自創門檻，書本未量化）

### C.2 存在性驗證（B 章）

- **B1** `turningWave.computeTurningWave()` — `turningWave.ts:48`
- **B2** `isUptrendWave()` / `isDowntrendWave()` — `ruleUtils.ts:31,44`（3 higherHighs + 2 higherLows）
- **B3** `trendAnalysis.findPivots()` — `trendAnalysis.ts:68-149`（MA5 pivot，支援 minSwingRatio）
- **B5** 葛蘭碧 8 條齊全 — `granvilleRules.ts`（買 1-4 + 賣 5-8 全部 TradingRule）
- **B6** 三根 K 線反轉（夜星/晨星）— `threeBarReversalRules.ts:17,234`
- **B7** 底部形態（黃金右腳、草叢量）— `bottomFormationRules.ts:49-100+`
- **B8** `halfPrice()` — `ruleUtils.ts:18-21`
- **B10** 240MA（年線）— `indicators.ts` 計算清單含 ma240

### C.3 概念類（C 章）

- **C3** 長上影線紅 K 警訊 — `smartKLineRules.ts` `hasLongUpperShadow()`（已偵測，警訊標記待確認）
- **C5** 紅黑配 6 組 — `klinePatterns.ts`、`twoBarReversalRules.ts`（吞噬 / 覆蓋 / 貫穿已實作，遭遇/標準缺，**4/6**）
- **C6** 黑紅配 6 組 — `threeBarReversalRules.ts:234+`（晨星 / 母子 / 雙星已實作，**3-4/6**）
- **C7** KD 背離 detector — `indicatorPatterns.ts` `detectKdPeakDivergence()`
- **C8** 量價背離 detector — `volumePatterns.ts` `detectVolumePriceDivergence()`
- **C11** 切線突破 / ABC 形態 — `buyMethodTracks.ts:150` J 軌 + `longTermSopRules.ts`「月線突破下降切線」
- **C12** 主力誘多警訊（概念） — `entryProhibitions.ts` 註解、`bottomFormationRules.ts` 草叢量（概念存在，無獨立 detector，**部分實作**）

### C.4 結構（D 章）

- **D1** 買法字母 B/C/E/J/K/L/M/P/D/F/N/O/Q/R 軌道分流 — `buyMethodTracks.ts:147-163`
- **D2** 反轉軌 D/F/N/O 對應書本 — 一字底/V 型反轉/型態確認/打底完成
- **D3** Q 戰法軌 MA3+10+24 — 2026-05-22 已從 OCR 確認對齊書本《抓住線圖》p.262（非自創）
- **D4** 六條件 + 戒律 + 淘汰法 — `applyPanelFilter.ts` + `entryProhibitions.ts` + `eliminationFilter.ts`
- **D5** MTF 週線六條件 gate — `applyPanelFilter.ts:37` `mtfWeeklyPass`
- **D6** 出場規則（跌破 5 均 / 月線 / 頭頭低） — 多檔 detector 已覆蓋

---

## D. 後續行動優先序

從 99-V12差異報告.md 摘錄，並標註 commit 669f273 後最新狀態：

### Tier 1（直接影響勝率 +3-5%）

1. **補 MA 斜率排序維度**（B9/C13 整合） — ✅ commit 669f273 已部分補
   - 待確認：是否完整覆蓋 `applyPanelFilter.ts:54-67`
   - 風險：偏離的波浪是否真被篩除（需回測驗證）

2. **實作「弱中透強 / 強中透弱」detector**（C1） — ⚠️ commit 669f273 僅「弱中透強加持」
   - 待補：對稱版「強中透弱」（黑 K 但高收/高開低收）
   - 來源混淆：commit 標朱老師但實為林穎 CH2-2（需更新 commit message / docs）

3. **完善位置 metadata 系統 — 接近壓力區**（C9） — ✅ commit 669f273 已補
   - 待確認：`detectPressureZone()` 是否寫入 `trendAnalysis.ts`
   - 進階：close ≥ swingHi × (1-3%) 的 3% 門檻可調

### Tier 2（勝率 +1-2%，需複核確認）

4. **驗證六條件「月線向上」引用**（D4） — ❌ 未動
   - 行動：讀 `lib/analysis/highWinPositions.ts` 或 `SixConditionsEvaluator` 確認
   - 難度：⭐ 低（純檢驗）

5. **補「主力誘多警訊」獨立偵測器**（C12） — ❌ 未動
   - 行動：新增規則 → 空頭趨勢 + 量增反彈紅 K = 誘多警訊
   - 預期：空頭中止誘多單損失 2-3%

---

## E. 文件變更清單

本報告列舉的實作缺口涉及以下檔案（**僅追蹤，未修改**）：

**優先修改順序**：
1. `lib/selection/applyPanelFilter.ts` ← 加 MA 斜率排序（commit 669f273 部分補）
2. `lib/rules/smartKLineRules.ts` ← 加弱中透強 / 強中透弱 detector
3. `lib/analysis/trendAnalysis.ts` ← 完善位置判定（commit 669f273 已補）
4. `lib/analysis/highWinPositions.ts` ← 驗證六條件細節（檢驗用）
5. `lib/analysis/maPivot.ts` ← 加 `daysUntilMaTurn()`（B4 真缺漏）

---

## F. CH4 成交量 + CH5 選股 缺口（2026-06-04 新增）

CH4/CH5 課程上線後逐項對照 v12 code（生產 gate 在 `MarketScanner.scanOne()`）。詳細教學對應見 [zhu_online_course_ch4.md](../zhu_online_course_ch4.md) / [zhu_online_course_ch5.md](../zhu_online_course_ch5.md)。

### F.1 CH4 成交量缺口

| 編號 | 項目 | 課程值 | code 現值 | 證據 | 狀態 |
|---|---|---|---|---|---|
| **C-V1** | 攻擊量基準 | 基本量（**5 日均量**）× **1.2~1.3 倍以上**（朱口述）| 今日量 > **前一日** × 1.3 | `trendAnalysis.ts:755`、`bookThresholds.ts:22` | 🟡 **倍數 1.3 已對齊**（書本 p.54 + 朱口述上界），唯基準「前日」vs「5 日均量」不同。**低優先** |
| ~~C-V2~~ 爆大量門檻 | — | 基本量 × **2 倍以上**（朱口述，原誤記 3）| `avg5 × 2` | `volumePatterns.ts:42` | ✅ **已對齊**（逐字稿核對後撤銷此缺口）|
| **C-V3** | 草叢量 / 黃金右腳 | 打底盤整大量 = 主力進貨 | 已實作但**未進主掃描** | `bottomFormationRules.ts:107,49`（只在 rule engine + 自選股/ETF 監控）| 🟡 反轉軌打底走字母 O，未用這兩個 detector |
| **C-V4** | 末升段三條件 | 連 3 長紅 + 暴量 + MA20 乖離>15%**同時** | 5 訊號**任 2** 即判 | `trendAnalysis.ts:488-518` | 🟡 較寬鬆 |

> ✅ **已對齊**：9 種量分類（`classifyVolume()`）、量價背離三型、窒息/凹洞量、高檔爆量三型、淘汰法 R4/R9。

### F.2 CH5 選股缺口

| 編號 | 項目 | 課程 | code 現況 | 狀態 |
|---|---|---|---|---|
| **C-S1** | universe 硬篩 | 去量過低（逐字稿未給張數）、去價**<5 元**（朱原話）| 只有成交額 20 日均 top-N（TW500/CN800），**無量/價硬篩** | 🔴 缺漏（`TurnoverRank.ts`）|
| **C-S2** | 底部圖形③ | 反彈突破月線橫盤 → 月線上揚突破 | 無獨立 detector（K 橫盤近似）| 🔴 |
| **C-S3** | 強勢飆股主升段 | 鎖第一波高檔、等第二波主升段 | 無「鎖第一波等第二波」專屬選股法 | 🔴 |
| **C-S4** | 類股群聚 | 同類股齊漲 = 題材股 | 無類股群聚偵測 | 🔴 |
| **C-S5** | 淘汰項 7 | 長期打底未突破大量壓力 | 無對應 detector | 🔴 |

> ⭐ **重大正向發現**：CH5-6「獵兔計畫 8 分類」（等打底/突破/拉回/上漲/K線橫盤/ABC/型態/突破大量黑K）與 v12 買法字母 **O/C/P/B/K/J/N/L 完整 1:1 對應** — 這是「v12 字母軌道源於書本」最直接的鐵證，建議補進 STRATEGY_BOOK_REFERENCE。
>
> 🟡 **六六大順 vs 六條件**：6 條內容全對應，但 (1) 課程是「順序短路」、v12 同時計算不短路；(2) 位置/均線次序對調；(3) 課程把「量+K線」綁一條、v12 拆④⑤；(4) 課程⑥指標是第 6 步、v12 當加分（= 書本要 6 全齊、rockstock 放寬 5/6）。
>
> 🔴 **淘汰法資料/範圍限制**：課程淘汰項⑬法人連續賣超（R8）、⑮有基本面沒技術面（R11）、⑭看不懂（R10）在 v12 已移除（無法人逐日資料 / 超出系統範圍）—— 屬刻意取捨，非 bug。

### F.3 CH1-3 既有缺口重驗（2026-06-04，逐檔重讀）

原 §A/§B 13 項今日現況：

| 項次 | 原狀態 (05-22) | 現狀態 (06-04) | 證據 |
|---|---|---|---|
| B9/C13 MA20 斜率排序 | 🟡 部分 | **✅ 完整** | `applyPanelFilter.ts:71-73` + `panelSortKey:87-90`（雙方多頭時第三鍵）|
| C9 接近壓力區 metadata | ✅ | **✅** | `trendAnalysis.ts:18,498`（`NEAR_SR_PCT=0.03` + 對稱支撐版）|
| C1 弱中透強 / 強中透弱 | 🟡 僅單向 | **✅ 對稱齊全** | `ruleUtils.ts:292,300`；高檔強中透弱已 live（`smartKLineRules.ts:82` 註冊）；低檔弱中透強僅 util |
| C5/C6 紅黑配 / 黑紅配 | 🟡 4/6、3-4/6 | **✅ 全齊 live** | 2 根 8 條（`twoBarReversalRules.ts:300`）+ 3 根 6 條（`threeBarReversalRules.ts:307`）皆註冊 |
| B4 `daysUntilMaTurn()` 扣抵預測 | 🔴 | **🔴 仍缺** | `maPivot.ts` 只有事後 pivot 判向，無扣抵預測 |
| C2 該漲不漲 detector | 🔴 | **🔴 仍缺** | 最接近 `reversalPatternRules.ts:160`（爆量後不創高，語意不同）|
| C4 遭遇線 / 一日封口 | 🔴 | **🟡 封口有、遭遇線無** | `gapPatterns.ts:149` `isTrueGapFillUp` 有；遭遇線無 |
| C10 次日確認延遲 | 🔴 | **🟡 型態軌有、變盤線無** | `provisionalManager.ts` 只套 K/D 型態軌，變盤線無 flag |
| A1/A2 長紅/長黑 6.5% 平行版 | 🟡 | **🔴 仍缺** | `ruleUtils.ts:9,14` 仍 2%，無 `isMaxBullishCandle` |
| A4 中棒分級（3.5~6.5%）| 🟡 | **🔴 仍缺** | `ruleUtils.ts` 仍小/中長二分 |
| A6 葛蘭碧買 4 乖離 | 🟡 −10% | **🔴 仍不對稱** | `granvilleRules.ts:173` 買4 −10% / `:324` 賣8 +15%（未引 `HIGH_DEVIATION_PCT=0.15`）|
| A9 高/低檔倍數版 | 🟡 | **🟡 本體未加**（他處有長線漲倍警示 `longTermSopRules.ts:293`）| `ruleUtils.ts:331,338` |
| A10 均線糾結門檻 | 🟢 自創 | **✅ 不變** | `bookThresholds.ts:90,92`（3% / 15%）|

> 📌 **觀察（非原 13 項）**：`lib/analysis/klinePatterns.ts` 那套 K 線組合 detector（上升/下降三法、晨星 6 變化、吞噬/覆蓋/貫穿）**無任何 import**，與 live 的 `twoBar/threeBarReversalRules` 兩套並存，疑為 dead code，可清理。

### F.4 本輪行動優先序（僅列缺口，未改 code）

> 守 FUNDAMENTAL_REQUIREMENTS #5/#7/#9/#10 — 任何 code 修補先過 `npm run test:contracts` 再分批進。

- **Tier 1（選股直接相關）**：C-S1 universe 量/價硬篩（最易補、回測可驗）。
- **Tier 2（補偵測器）**：C-S2 反彈突破月線橫盤、C-S5 長期打底未突破壓力、C-V4 末升段三條件收嚴。
- **Tier 3（沿用 05-22 待辦）**：B4 扣抵預測、C2 該漲不漲、A1/A4 K 棒 6.5%/中棒分級、A6 葛蘭碧買 4 乖離對稱；C-V1 攻擊量 5 日均量基準平行版（低優先，倍數已對齊）。
- **清理**：`klinePatterns.ts` dead-code、低檔弱中透強包成 live rule。

### F.5 寫筆記時額外發現（⚠️ agent 逐字稿+code-map 推斷，動手前需複核）

逐課讀逐字稿撰寫 CH4/CH5 筆記時順帶發現、不在前述編號內的缺口：

| 觀察 | 出處課 | 說明 | 優先 |
|---|---|---|---|
| **起漲紅 K 最低點「生死線」未實作** | 4-4 | 朱：起漲大量紅 K 次日跌破其最低點 → 誘多出貨/假突破。v12 無「起漲 K 最低點守破」判定 | 中（影響假突破過濾）|
| ~~**「逃命波」無反向標記**~~ ✅ 已實作（賠少-4） | 4-9 | 破月線 + 破前低後的反彈禁止做多 → `sellSignals.ts` 新增 `ESCAPE_WAVE`（high severity，holdingVerdict 自動判該出場）。純出場側，不接進場 gate | 中 |
| **空頭續跌量能分級全無** | 4-8 | 行進間大量長黑=還有低點 / 換手成功失敗 / 做空月線季線分級，v12 偏多頭、空側僅 cn-sanse 自創因子 | 低（與 CN-only 邊界相關）|
| ~~**一日反轉只實作一半**~~ ✅ 已補（賠少-6/19） | 4-7/4-9 | `sellSignals.ts` 新增「次日確認」兩根 K 棒事件窗：`BLOWOFF_BLACK_CONFIRMED`（爆量長黑+次日破其低）、`UPPER_SHADOW_NEXTDAY_BREAK`（高檔爆量長上影紅K+次日破其低）。降假訊號，純出場側 | 低 |
| **爆量門檻三處不一致** | 4-6 | 黃金右腳 1.8× / 草叢量 avgVol20×2 / O 打底 avg5×1.5，同源一書三套閾值，建議統一進 `bookThresholds` | 低（清理）|
| **強勢飆股缺「第一波強勢」前提 + 題材熱度維度** | 5-5 | B 軌撈一般多頭回檔，缺書本核心前提「先有凌厲第一波」；`letterWeights` 是字母權重非題材熱度 | 中 |
| **鎖股「優先順序」缺時序緊迫度** | 5-6 | `panelSortCompare` 只有漲幅/六條件分/MA20 斜率，無「盤到尾端=即將發動排最前」的時序權重 | 中 |
| **LockWatch 僅服務 F/N，缺持久化跨日鎖股庫** | 5-6 | 書本 8 分類都先鎖股守兔、發動才進；v12 把 D/O/多頭軌做成「確認當天直接進場」，且無狀態快照重算非真正跨日汰弱資料庫（架構級差異）| 架構級，暫不動 |

---

## 附註

**審查方法論**：
- ✅ 逐檔讀源碼（11 個核心檔案）
- ✅ grep 跨檔驗證實作覆蓋
- ⚠️ 部分 detector 的「書本對應」基於檔案註解推斷，未逐一回查原書

**已知限制**：
- 本審查未驗證「執行時」參數是否正確傳遞（僅驗證定義）
- 未檢視 test suite，故無法確認某些邊界條件的正確性
- 「預期影響」為定性估計，需回測驗證

**素材來源**：
- 課程筆記：`~/Desktop/朱家泓課程/筆記/`（24 章 + 3 份對照報告）
- 99-V12差異報告原文：`~/Desktop/朱家泓課程/筆記/99-V12差異報告.md`（218 行）
- 課程vs書本差異：`~/Desktop/朱家泓課程/筆記/98-課程vs書本差異.md`（173 行）
- 總綱（含口訣 + 缺口）：`~/Desktop/朱家泓課程/筆記/00-總綱.md`（167 行）

---

**最後同步**：2026-06-04（CH4 成交量 + CH5 選股 上線 → 新增 §F + CH1-3 重驗）
**下次審查觸發**：§F Tier 1/Tier 2 行動完成、或課程再有新章上線時（CH1-5 五章已全數上線完畢）
