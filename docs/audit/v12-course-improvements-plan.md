# v12 課程改進執行計畫（CH1-5 → v12 code）

> **目的**：把朱家泓線上課 CH1-5 學到、但 v12 還沒做/做得不一樣的東西，**分批改進 v12 選股 code**。
> **findings 來源**：[v12-gaps-from-online-course.md](v12-gaps-from-online-course.md)（§0 一覽 + §F 缺口清單）。本檔是「怎麼執行」。
> **建立**：2026-06-04。**執行方式**：每批一個 git branch / PR，照順序做，過 gate 才進下一批。

## ⚠️ 鐵則（每一項都適用，不可跳過）

1. **選股單一事實同步**（CLAUDE.md #10）：任何門檻/邏輯改動要同步四處 —— `lib/selection/applyPanelFilter.ts`、`lib/scanner/ScanPipeline.ts`/`MarketScanner.ts`、`store/backtestStore.ts`、`__tests__/contracts/scan-parity.test.ts`。
2. **先過合約測試**：改完跑 `npm run test:contracts`，**綠了才算數**。
3. **會動到選股結果的，先回測**：用 `scripts/backtest-*.ts` 跑「改動前 vs 改動後」比勝率/期望報酬；**沒有提升或變差就不要進**（這幾項在表格標 🎯 需回測）。
4. **branch 不碰 main**；commit 帶 `--author "tc19911029 <tc19911029@gmail.com>"`。
5. **不要盤中/盤後重啟 prod server**（會觸發 local-cron 下載風暴）。
6. **不違反書本鐵則 #5**：只加「書本/課程有依據」的因子，不自創。表格每項都附書本/課程出處。

## 決策原則：「改完整」≠「全部硬塞」

- **參數對齊類**（B1）：書本白紙黑字、低風險 → 直接改 + 合約測試。
- **新偵測器/改選股結果類**（B2/B3）：🎯 **逐項回測**，有 alpha 才留；沒提升就記錄「試過、無效」後撤回（不是失敗，是驗證）。
- **清理類**（B4）：不動選股邏輯 → 安全。

---

## Batch 1 — 安全參數對齊（書本明確、低風險）

| # | 改什麼 | 檔案:行 | 怎麼改 | 書本依據 | 驗證 |
|---|---|---|---|---|---|
| 1.1 | 葛蘭碧買 4 乖離 −10%→**−15%** 對稱 | `lib/rules/granvilleRules.ts:173`（買4 `dev >= -0.10`）| 改 −0.15，並改引用 `bookThresholds.ts:142 HIGH_DEVIATION_PCT=0.15` 單一常數（賣8 `:324` 已 +0.15）| CH3 葛蘭碧、書本對稱 ±15% | 合約測試 + 🎯 回測買4觸發頻率 |
| 1.2 | 中棒分級 + 6.5% 長紅平行版 | `lib/rules/ruleUtils.ts:9,14,59,106`（`isLongRed/Black`、`isSmall/MedLong`）| **新增** `isMaxBullishCandle/isMaxBearishCandle(≥6.5%)`、`isMediumRed/Black(3.5~6.5%)`；先「平行存在」不動既有 2% gate | CH2-4/2-5 長紅 6.5%、三級制 | 合約測試（新增 helper 不破壞既有）|
| 1.3 | universe 加 **價<5 元**硬篩 | `lib/scanner/TurnoverRank.ts:89-147 buildTurnoverRank`| 排名前先濾 `close >= 5`（**TW only**；CN 價階不同，先不套或另訂）| CH5-2 特別報價「去價<5 元」| 合約測試 + 🎯 回測 universe 變化（預期低衝擊，top-N 已濾多數）|

**完成定義**：3 項各自 branch→改→`test:contracts` 綠→（1.1/1.3）回測無變差→PR。1.2 純新增 helper 可先不接 gate。

---

## Batch 2 — 新偵測器（🎯 每項都要回測，有 alpha 才留）

| # | 改什麼 | 起點檔案 | 怎麼做 | 出處 |
|---|---|---|---|---|
| 2.1 | **起漲紅 K「生死線」** | `lib/scanner/provisionalManager.ts`（假突破驗證層）| 起漲大量紅 K 記其最低點；之後 N 日跌破 → 標誘多出貨/假突破、撤候選 | CH4-4（最高價值）|
| 2.2 | **末升段收嚴**（5 訊號任 2 → 三條件同時）| `lib/analysis/trendAnalysis.ts:488-518 detectTrendPosition`| 把 `endSignals>=2` 改成要 `hasConsecLongRed(:409) && 暴量 && isBiasOverExtended(:474)` 同時 | CH4-3/4-7 末升段三條件 |
| 2.3 | **長期打底未破壓力**淘汰 | `lib/scanner/eliminationFilter.ts`（加一條 R）| 長期打底 + 未突破上方大量 K 高點 → 淘汰 | CH5-3 淘汰⑦ |
| 2.4 | **底部圖形③**（反彈突破月線後橫盤）| `lib/analysis/v12LetterO.ts` 或新 detector | 反彈過月線→月線上方橫盤→月線上揚+帶量突破 | CH5-4 第③種 |

**完成定義**：每項單獨 branch + 回測報告（勝率/期望報酬/樣本數，改前改後）。**有提升才 PR**，無提升在本檔記「2.x 試過無 lift、撤回」。

---

## Batch 3 — 較難 / 需設計（逐項評估，可能跨多個 session）

| # | 改什麼 | 出處 | 備註 |
|---|---|---|---|
| 3.1 | 強勢飆股「第一波強勢前提」 | CH5-5 | 需定義「第一波夠強」量化；題材熱度無資料源（先只做價量強度版）|
| 3.2 | 鎖股「時序緊迫度」排序維度 | CH5-6 | `applyPanelFilter.ts panelSortCompare` 加「盤到尾端=即將發動」權重，🎯 回測 |
| 3.3 | 扣抵預測 `daysUntilMaTurn()` | CH3-2 | `lib/analysis/maPivot.ts` 加函式（用扣抵價反推 MA 翻向天數）|
| 3.4 | 遭遇線 / 該漲不漲 / 變盤線次日確認 | CH2 | 各加 detector：`klinePatterns.ts`(遭遇線)、`smartKLineRules.ts`(該漲不漲)、`provisionalManager.ts`(變盤線次日確認 flag) |

---

## Batch 4 — 純清理（不動選股邏輯、安全）

| # | 改什麼 | 檔案 | 動作 |
|---|---|---|---|
| 4.1 | `klinePatterns.ts` dead-code | `lib/analysis/klinePatterns.ts` | 先確認真無 import（與 live 的 `twoBar/threeBarReversalRules` 並存）→ 移除或標 deprecated |
| 4.2 | 爆量門檻三處不一致統一 | `bottomFormationRules.ts:49(1.8×)/:122(avg20×2)`、`v12LetterO.ts(avg5×1.5)` | 統一收進 `lib/analysis/bookThresholds.ts` 具名常數 |
| 4.3 | 低檔弱中透強包 live rule | `lib/rules/smartKLineRules.ts` + `ruleRegistry.ts` | 把 `ruleUtils.ts:292` 弱中透強 util 包成 TradingRule 並註冊（對稱高檔強中透弱已 live）|

---

## 回測怎麼跑（B1/B2/B3 的 🎯 項）

```bash
# 改動前：先存 baseline
npx tsx scripts/backtest-<對應市場/策略>.ts > /tmp/baseline.txt
# 改動後：同腳本再跑，比勝率 / 期望報酬 / 進場數
npx tsx scripts/backtest-<...>.ts > /tmp/after.txt
diff <(grep -E '勝率|期望|樣本|進場' /tmp/baseline.txt) <(grep -E '勝率|期望|樣本|進場' /tmp/after.txt)
```
（實際腳本名以 `ls scripts/backtest-*.ts` 為準。）

## 如何在新 session 開跑（貼這句）

> 「在 rockstock 專案，照 `docs/audit/v12-course-improvements-plan.md` 執行 **Batch 1**。開 branch、逐項改、過 `npm run test:contracts`，1.1/1.3 跑回測比改前改後，沒變差才 commit（`--author tc19911029`）。做完回報，我再決定要不要進 Batch 2。」

每批做完回報、確認 OK 再開下一批 —— 不要一個 session 硬幹 4 批。
