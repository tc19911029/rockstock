# 深度全功能測試 + 問題深挖 — 2026-06-06（第二輪）

> 第一輪（[functional-test-2026-06-06.md](functional-test-2026-06-06.md)）找了 F1–F6 並修復上線。
> 本輪：**每個功能仔細互動測試 + 程式碼/資料邏輯深挖**。
> 雙軌：4 個背景子代理稽核子系統 code + 我互動式深測 UI。
> 規則：**只記錄、先不修**，等使用者確認。

## 修復狀態（使用者確認「幫我修好」後，2026-06-06）

| # | 結果 | 修復 |
|---|------|------|
| **DF1** | ✅ 已修 | `size-suggestion/route.ts`：市場判定改 `classifyMarket()`（處理 .TWO/裸碼）取代 `endsWith('.TW')` |
| **DF2** | ✅ 已修 | `limitMoveGuard.ts`：`limitPctFor` 委派 `getLimitMovePct`（單一事實，含 689 科創/全創業板），保留 margin |
| **DF3** | ✅ 已修 | `append-from-snapshot/route.ts`：個股守衛 `> date`→`>= date`，L1 已封今日 bar 不被 L2 蓋 |
| **DF4** | ✅ 已修 | `MarketScanner.ts`：`scanOneShort` 補上多方同款 L1-staleness fail-closed 守衛 |
| **DF8** | ✅ 已修 | `cn-sanse/scanStorage.ts`：`saveSanSeScan` 加 `evaluated===0` 守衛（鏡像 TW），force=1 也保護 |
| **DF5** | ✅ 已修 | `merger.ts`：`weightedStrength` normalize 對齊 `computeFacetScores`（*50/*25） |
| **DF6** | ✅ 已修 | `v12StockEvaluator.ts`：`LONG_TREND_LETTERS` 改從 `BULLISH_TRACK_LETTERS` 派生（PIVOT_GATE 保留精選子集） |
| **DF7** | ✅ 已修 | `trendAnalysis.ts`：註解 MA20 乖離 20%→15%（與 code 一致） |
| **DU1** | ✅ 已修 | `app/page.tsx`：切市場 effect 加守衛 —「當前圖是個股」則保留不覆蓋（使用者選「保留個股圖」） |
| **DU2** | ✅ 已修 | `FundamentalSidebarPanel.tsx`：走圖回放時加警示「基本面/估值為最新資料、非走圖日」（用 `currentIndex<last` 判回放，避免週末誤判；使用者選「加標籤註明最新日」） |
| **DU3** | ✅ 已修 | `agents/[symbol]/page.tsx`：instructions 加註「多代理只評估當日掃描候選股」設定預期 |

**驗證**：`tsc --noEmit` 乾淨；`npm test` 120 套件 / 1651 passed / 0 fail（DF + DU 兩批修完後重跑）。

---

## 深挖問題清單（彙整）

> 來源：[C]=子代理 code 稽核　[U]=我互動式 UI 測試
> 嚴重度：🔴 壞掉/錯誤　🟡 功能異常但可繞　🔵 體驗/顯示/精度　⚪ 待確認

| # | 來源 | 頁面/模組 | 嚴重度 | 問題 | 證據 |
|---|------|-----------|--------|------|------|
| **DF1** | [C] | `/sizer` 部位試算 | 🟡 | `app/api/portfolio/size-suggestion/route.ts:112` 用 `candidate.market ?? symbol.endsWith('.TW')?'TW':'CN'` 推市場。sizer 頁只送 symbol 原樣、**不送 market**（page.tsx:70）→ **上櫃 `.TWO`** 與**裸碼**（如 `2330` 沒後綴）都 endsWith 失敗 → 誤判成**陸股**：張數用 100 股而非 1000、手續費用 CN 0.031% 而非 TW 0.1425%。其餘程式都用 `classifyMarket()`（處理 .TWO）→ 此 route 是 outlier | 已讀 route:112 + sizer page:46/70/119（預設 placeholder `2330.TW` 故照打 TWSE 沒事，OTC 必中、裸碼必中）。修法：改 `classifyMarket(candidate.symbol)` |
| **DU1** | [U] | 首頁 圖↔掃描 市場耦合 | ⚪ | 切掃描 panel 的「台股/陸股」**同時把主圖換成該市場指數**（^TWII/上證），把使用者剛載入的個股（2330）蓋掉；且 `/?load=2330`（TW 股）載入後掃描卻停在 CN → 「圖市場」與「掃描市場」狀態耦合不一致、易誤操作丟失走圖 | 互測：load 2330→掃描停 CN；點掃描「台股」→主圖變 ^TWII。待確認是否刻意 |
| **DF2** | [C] | 漲停 guard（資料層） | 🟡 | `lib/datasource/limitMoveGuard.ts:29` `limitPctFor` 與正規版 `lib/utils/limitRules.ts:25` `getLimitMovePct` **分歧**：前者 `/^30[01]/`+`/^688/`，後者 `/^30\d{4}$/`（全創業板）+`/^68[89]/`（含 689 科創）→ 科創 689/創業板 302-309 被當 ±10% 板。L1 寫入守衛（saveLocalCandles/download-candles/append-from-snapshot）會把這類股合法 +12~19% 的 bar 誤判漲停污染而丟棄/跳過。**兩份事實**違反單一原則。今日 cn_stocklist 無此類碼故掃描路徑不受影響，但「走任意股 chart」會把這類股寫 L1 → 觸發 | Agent3 讀全部 call site；本 branch 已改該檔 |
| **DF3** | [C] | append-from-snapshot cron | 🟡 | `app/api/cron/append-from-snapshot/route.ts:111` 個股守衛 `existing.lastDate > date`（嚴格 >）→ L1 已封今日 bar（`lastDate===date`）時**不跳過**、`[...candles, {date,...q}]` append 不去重 → writeCandleFile 日期合併用 L2 snapshot 收盤**蓋掉權威收盤**（**踩 Fundamental Req #1**）。指數分支(148-151)有 `filter(c.date!==date)` 但個股分支沒有；且 line 117 `prev`=今日 bar 使 `suspectsLimitOverwrite` 比今日 vs 今日、守衛失效。下游 TWSE/TPEx cross-audit + eod-settle 會 heal，但依賴時序、個股/指數不對稱疑非預期 | Agent3 trace；本 branch 已改該檔 |
| **DF4** | [C] | 空方掃描 staleness | 🟡 | `lib/scanner/MarketScanner.ts:845-952` `scanOneShort` **缺多方有的 L1-staleness fail-closed 守衛**：`scanOne`(429-438) 在 `asOfDate===today` 但 `lastCandleDate!==asOfDate` 時拒收（防昨日 bar 被標今日）；空方路徑無此檢查、`scanShortCandidates`(975-981) 也沒預篩。空方在 production 跑（scan-tw/scan-cn/retry-scan 都 `directions:['long','short']`）→ post_close/intraday 空方可能納入 L1 已 stale 的股、卻蓋今日 trade_date（多方守衛當初就是擋這類污染） | Agent4：直接 code 不對稱、production path |
| **DF8** | [C] | CN 三色 scan 持久化 | 🟡 | `app/api/cn-sanse/scan/route.ts:35-38` + `lib/cn-sanse/scanStorage.ts:97` `saveSanSeScan` **無 degenerate/`evaluated===0` 守衛**，但 CN cron(`scan-cn-sanse` 有 `degenerateScanReason`) 與 **TW** 兩層都有（`saveTwSanSeScan` 有 `evaluated===0 return`）。互動路徑 `/api/cn-sanse/scan?force=1`（=記憶記載的手動補救動作）直接 `saveSanSeScan` → 000001.SS 指數封存 race 時算出 stale 近空結果、lastDate 卡前一日，**蓋掉當日好的 post_close 紀錄**（踩鐵律#1）。cron 免疫、人工 force 路徑暴露 | Agent2：TW/CN 守衛不對稱、verified |
| **DF5** | [C] | pool 排序正規化 | 🔵 | `lib/agents/candidates/merger.ts:148-157` `weightedStrength`（`tracks*10`/`youtube*20`）與 `poolWeights.ts:55-72` `computeFacetScores`（`*50`/`*25`）**兩套正規化分歧**。UI 永遠 `sort=weighted` → route 用 facetScores 重排，故 merger 排序對 UI 是 dead，目前不可見；潛在不一致 | Agent4：latent/dead-ranking |
| **DF6** | [C] | v12 評估器 track 硬編 | 🔵 | `lib/scanner/v12StockEvaluator.ts:104,106` `LONG_TREND_LETTERS`/`PIVOT_GATE_LETTERS` 用本地 literal 而非從 `buyMethodTracks.ts` 派生（同檔卻有正確 import `REVERSAL_TRACK_LETTERS`）。目前值相符，但加新字母不會自動流過來。僅 backtest/backfill 腳本用、不影響 production 選股 | Agent4 |
| **DF7** | [C] doc | trendAnalysis 註解過時 | 🔵 | `lib/analysis/trendAnalysis.ts:399` `isBiasOverExtended` 註解寫「MA5>15% OR MA20>20%」但 code 兩者都 `0.15`（符合 2026-04-22 設定，code 才對、prose 錯）。僅 display（feed trendPosition label、非選股 gate） | Agent4 |
| **DU2** | [U] | 首頁 基本面 tab @ 走圖 | ⚪ | 歷史走圖 asOf 2026-05-20 時，中間「基本面」tab 仍顯示「估值 **2026-06-05**」（PER 90.44 用當前價算），不跟隨 asOf 日 → 走圖回放把歷史價配當前估值、可能誤導。與第一輪估值卡 stale 同類。也可能刻意（基本面難 rewind） | 互測：華容 chart=05-20、基本面估值=06-05 |
| **DU3** | [U] | `/agents/[symbol]` 非候選股 | 🔵 | 對「非掃描候選」股（如 `/agents/2330`）仍顯示「⚡開始準備」按鈕 + 三步驟教學，點下去才報錯「symbol 2330 not in L4 session…Agent 只能評估掃描器選出的候選」。應對非候選 gate 掉按鈕／先提示，而非邀請一個必失敗的動作。錯誤本身優雅顯示、非崩潰（屬設計：多代理只評估候選池） | 互測：點 /agents/2330 開始準備 → 紅色 banner |

---

## A. 子代理 code 稽核結果（背景並行，皆完成）

- ✅ Agent 1 — portfolio/金額/sizing/risk/growth/journal → **DF1**（sizer OTC 誤判）。其餘 fee/PnL/Kelly/growthPath/risk 公式全對（對真實 trades.json 重算驗證）。
- ✅ Agent 2 — 三色 sanse → **DF8**（CN scan force=1 無守衛蓋好紀錄）。指標數學（dualB/williams-R/midStrength/zb4/單位/asOf-freeze）全對，golden test 護住。
- ✅ Agent 3 — 資料/報價/路由層 → **DF2**（漲停 guard 分歧）、**DF3**（append-from-snapshot 蓋 L1）。000001 撞庫/單位 splice/L1-L2 隔離都已硬化、無高危。
- ✅ Agent 4 — 選股流程 → **DF4**（空方缺 staleness 守衛）、**DF5/DF6/DF7**（低）。§0 隔離/MTF/六條件/track 路由/單一事實 紀律維持良好、contract test 過。

**彙整**：8 deep finding（🟡×5：DF1/DF2/DF3/DF4/DF8；🔵×3：DF5/DF6/DF7）+ DU1（⚪ UI 耦合）。
**共通主題**：DF3/DF4/DF8 都是「守衛不對稱」— 某路徑有 staleness/degenerate 守衛、平行路徑沒有 → 風險蓋掉已封存好資料（碰 Fundamental Req #1 / 鐵律 #1）。建議優先補這三處的對稱守衛。

---

## B. 互動式 UI 深測（逐功能）

> 不只看「有沒有渲染」，而是實際操作每個控制項、驗算輸出、測邊界。
