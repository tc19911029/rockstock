# v12 vs 線上課程缺口追蹤清單

**來源**：`~/Desktop/朱家泓課程/筆記/99-V12差異報告.md`（2026-05-21 用戶手寫 + Claude Code Explore Agent 逐檔審查）
**最後同步**：2026-05-22
**審查對象**：rockstock v12 codebase
**審查方法**：逐檔讀 11 個核心檔案 + grep 跨檔驗證，比對 40 個候選項

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

**最後同步**：2026-05-22
**下次審查觸發**：CH4+（成交量）課程上線後，或 commit 669f273 之後新增 Tier 1/Tier 2 行動完成時
