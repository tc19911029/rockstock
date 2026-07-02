# 全功能 Chrome 實測報告 — 2026-06-06

> 在實際 Chrome（Claude in Chrome）打 :3000 prod server 逐頁測試。
> 規則：**只記錄、先不修**，等使用者確認後再修。
> 測試時間：週六休市，L1 最新資料日 = 2026-06-05（週五）。

## 測試範圍（app/ 全路由）

靜態頁：`/` `/watchlist` `/portfolio` `/etf` `/youtube` `/youtube/replay` `/youtube/trends`
`/agents` `/agents/pool` `/agents/backtest` `/agents/memory` `/agents/portfolio`
`/health` `/growth` `/journal` `/realtime` `/risk` `/settings` `/sizer` `/today`
`/disclaimer` `/mockup` `/strategies/fundamental-revaluation` `/v12-deep-analytics` `/v12-performance`

動態頁：`/agents/[symbol]` `/youtube/stocks/[code]` `/diagnose/[market]/[symbol]/[date]`

待確認入口：`/cn-sanse` `/tw-sanse`（記憶提到、但 app/ page 清單沒出現 → 要驗證是否已整併進首頁或 404）

---

## 修復結果（2026-06-06，使用者確認「全部修」後）

| # | 結果 | 修復內容 | 驗證 |
|---|------|----------|------|
| **F1** | ✅ 排除（非 bug） | 查證為 Chrome 擴充套件噪音、非 app → 不改 code | dev :3100 console 證實 |
| **F2** | ✅ 已修 | `app/api/stock/quote/route.ts`：CN 改騰訊 `fetchQuote` 為主源、EastMoney fallback（原只 EastMoney 單次無重試→間歇 404） | dev 實打 600707/600487/000506/002613 全 200 |
| **F3** | ✅ 已修 | `components/portfolio/PortfolioDailyActionPanel.tsx`：總報酬 % 加「總」字 + tooltip，與「today 價格」區隔 | tsc + 測試 |
| **F4** | ✅ 已修 | `app/journal/page.tsx`：0 敗時盈虧比 `null→∞`（原除以零顯示 0.00） | 畫面確認顯示 ∞ |
| **F5** | ✅ 已修 | `lib/realtime/monitorPool.ts` 也讀 `data/portfolio/holdings-cn.json`（CN 持倉自動納監控）；清掉 `extra-symbols.json` stale 的 603986 | `/api/realtime/pool` 回 600487、無 603986 |
| **F6** | ✅ 已修 | `app/diagnose/.../page.tsx`：symbol 補市場 suffix 正規化（裸碼 2330→2330.TW） | dev 裸碼診斷回 200 |
| **D1** | ✅ 已修 | `CLAUDE.md` 頁面職責表加 redirect 校正註 | — |
| **D2** | ✅ 無需改 | grep 確認 app/components/lib 無指向 `/cn-sanse`/`/tw-sanse` 的內部連結 | grep |
| **O1** | ✅ 無需改 | fundamental 檔結構正常，`top100:[]` 是當日 0 檔達 ≥75 門檻的合理結果 | 檔案結構檢查 |

**測試**：`npm test` 120 套件 / 1651 passed / 0 fail；`npm run test:contracts` 53 套件 / 746 passed；`tsc --noEmit` 乾淨。

---

## 問題清單

> 嚴重度：🔴 壞掉/不可用　🟡 功能異常但可繞　🔵 體驗/顯示小問題　⚪ 待確認

| # | 頁面 | 嚴重度 | 問題 | 證據 |
|---|------|--------|------|------|
| F1 | ~~全 app hydration~~ → **非 bug** | ✅ 排除 | **更正**：dev server（:3100，dev 模式會詳列 hydration 錯誤）抓到那些 EXCEPTION 的真實內容是 `Error: A listener indicated an asynchronous response by returning true, but the message channel closed before a response was received` — 這是 **Chrome 擴充套件**（`chrome.runtime.onMessage`）的噪音，**web app 不可能產生**（rockstock 不用 chrome.runtime）。每頁都有、整頁載入觸發、:0:0 無 source 全部對上「擴充注入每頁」。dev 模式 console **無任何真 hydration 錯誤**。→ **不是 app bug，不需改 code**（很可能是 Claude-in-Chrome 擴充本身或廣告攔截器） | dev :3100 console：6 筆 EXCEPTION 全是該擴充訊息；onlyErrors 無 React hydration 字樣 |
| F2 | `/api/stock/quote`（陸股） | 🟡 | **陸股即時報價間歇 404**：同一支 600487 數秒內 `404→200` 反覆；600707/002613/000506 持續 404，603823/000001.SS 正常 200，台股/^TWII 全 200。疑騰訊上游限流 + endpoint 無重試/fallback（記憶：EastMoney push2 常 502、騰訊為主源）。**不影響主畫面（用 L1 快取），但影響盤中更新/sanse 通知等依賴即時報價的功能** | 連兩次 fetch 同批：600487 第一次 404「無法取得報價」第二次 200；`cnQuote.ts` 在本 branch(feat/v12-batch1-safe-params) 有改動 → 需確認重試/fallback 邏輯。週六休市影響低但為潛在可靠性 bug |
| F3 | `/portfolio` 今日操作建議 | 🔵 | 面板格式「today [價格] [%] [損益]」中的 **% 是總報酬非當日漲跌**，但緊貼「today」顯示。2408 南亞科顯示綠色 **+76.6%**（總報酬）緊接「today 360.00」，易誤讀為今日大漲；實際今日 -8.86%（正因跌破 MA5 才觸發減半）。建議加「總」字或分行/改色 | 放大截圖：2408「today 360.00 +76.6% +NT$937,020」對照下方持股卡「+75.69%(總) / -8.86%(今日)」。待確認是否刻意設計 |
| F4 | `/journal` 交易日誌 | 🔵 | **盈虧比顯示 0.00**：2 筆平倉皆獲利（勝率 100%、0 敗），但「盈虧比 0.00（勝 +38.6% / 敗 0.0%）」= 除以零未處理。100% 勝率卻顯示盈虧比 0.00 易誤讀為績效差，應顯示 ∞ / N/A / —「尚無虧損交易」 | 截圖：累計 2 筆、勝率 100.0%、盈虧比 0.00 |
| F5 | `/realtime` 分時監控 | ⚪ 待確認 | 監控清單 = `2408.TW 3661.TW 3006.TW 603986.SS`，但 **603986.SS 兆易創新已於 2026-05-28 換股平倉**（journal 證實），現持 CN 是 **600487.SS 亨通光電**（agents/portfolio 證實 4 檔含 600487）。→ 監控盯著已賣的、漏盯現持的。待確認清單來源（持倉衍生 or 手動 `data/realtime/sanse-watch.json`，git status 顯示該檔有改）。週末 0 根影響低 | journal：603986.SS 出場 05-28 換 600487；agents/portfolio：600487.SS 進場 77×20100 為現持 |
| F6 | `/diagnose/[market]/[symbol]/[date]` | 🟡 | **symbol 未正規化**：裸碼 `2330` →「找不到 TW/2330 L1（未涵蓋）」；帶 `2330.TW` → ✅ 正常出診斷。但全 app 其他入口（搜尋框 /`/agents/2330` /`/youtube/stocks/2330`）**都吃裸碼** → 不一致，照習慣打裸碼就壞。應在 diagnose 補 market suffix 正規化（CN 同理需 `.SS`/`.SZ`） | A `/diagnose/tw/2330/2026-06-05`=L1未涵蓋；B `/diagnose/tw/2330.TW/2026-06-05`=收盤2365 六條件3/6 完整；C `/diagnose/tw/2330/2026-06-04`=同樣失敗 |
| D1 | CLAUDE.md 頁面職責表 | ⚪ docs | 頁面職責表把 `/youtube`、`/youtube/trends`、`/youtube/replay`、`/agents`、`/agents/pool`、`/today` 列為獨立頁，但它們**現在都是 client-side redirect → 首頁對應 tab**（Stage 7 合併）。文件與實作不符，易誤導 | grep 出 6 個 redirect stub；逐一導航皆跳回 `/?tab=...` |
| D2 | `/cn-sanse`、`/tw-sanse` | ⚪ 待確認 | 兩路由已移除 → 乾淨 404（有「回到主頁」，非崩潰）。但記憶/舊文件曾以此為入口；需 grep 確認無殘留內部連結指向（若有會 404）。三色功能已整併進首頁 tab + 走圖疊圖 | 導航皆回 404 頁 |
| O1 | `/strategies/fundamental-revaluation` | ⚪ 待確認 | header「30 候選」但 Top 20(0)/Top 100(0)、僅 估值偏滿(3)+資料不足(7) 有數，其餘 ~20 落入「排除」。可能正常（當日無 ≥75 分強候選）也可能 fundamental cron 未完整跑。低優先 | 截圖：2026-06-05 寫於 19:46:31 |

---

## 逐頁測試紀錄

### `/` 首頁（即時看盤工作台）
- 狀態：✅ 載入正常
- 預設標的：000001 上証指數（2026-06-05，4027.74，趨勢空頭）
- 左：K線圖 + MA/KD/MACD + 頭底標記 ✅
- 中：條件/訊號/籌碼/基本面 tabs、三色條件面板、持倉 4 ✅
- 右：策略掃描（三色資金掃 800 檔、排序應買、有股票清單）✅
- ✅ 搜尋框自動完成正常（輸入 2330 → 跳「2330 台積電」建議）
- ✅ 載入台積電 2330：圖換成台積電 2365.00、MA 全更新、籌碼 tab 變台股版（外資/投信/自營/大戶400張/1000張）、三色條件換台股訊號、成交量單位變「張」→ market-aware 切換正確
- ⚠️ console：載入期穩定 2 EXCEPTION（見 F1）
- 待測互動：切 1分/5分/日/週月、切三色 tab、台股/陸股掃描切換、切掃描日期、持倉面板展開、L1-L4 收盤鈕

### `/watchlist` 自選股 — ✅ 正常
- 自選股 1 支（600707 彩虹股份 $11.71 +6.55%，Q 三條均線戰法）；輸入框/分頁（全部/台股/陸股）/走圖/筆記皆在。F1 exception ×2。

### `/portfolio` 持倉 — ✅ 正常（含 F3 小問題）
- 今日操作建議（3 檔需動作：南亞科減半/世芯全出/晶豪科停損，依書本 MA5/10/20）；台股市值 NT$68.16M +10.05%、陸股 ¥1.93M +24.70%；持股 4 檔含走圖/分析/編輯/刪除/批量準備分析。F1 exception ×2。見 F3。

### `/etf` ETF 追蹤 — ✅ 正常
- 4 分頁（績效排行/持股異動/共識買榜/被納入後表現）；ETF 篩選 chips（00400A~00984A）；各 ETF 加減碼統計 + 標的明細（持股變動/幅度/權重）。資料合理。F1 exception ×2。

### `/youtube`、`/youtube/trends`、`/youtube/replay` — ✅ 正常（刻意 redirect）
- 三者皆 client-side redirect → `/?tab=youtube`（Stage 7 已合併進首頁右側「YouTube 提及」tab，保留 URL 給 bookmark 相容）。**非 bug**。
- 首頁 YouTube tab 內容正常：2026-06-05 跨節目共識、36 檔（A3/B12/C2/未評19）、提及股票含節目來源與引述。
- ⚠️ CLAUDE.md「頁面職責表」仍把這些 redirect 當獨立頁列 → 文件過時（見 D1）。

### `/agents/2330` 個股詳細頁 — ✅ 正常
- 台積電 2330，多代理分析 0/4 未開始（操作指示：開始準備 →`/multi-agent-decide`→ 重整）；走圖與首頁同步、market-aware 籌碼 tab、日期切換列。

### `/health` 資料健康 — ✅ 正常
- 總狀態綠「正常」；台股/陸股 歷史日K 覆蓋率 100%、近3日落後0、gap 台3/陸32（容忍內）；盤中快照最新（台2093/陸3064 筆 @06-05 15:57）；掃描結果 06-05（台6/陸3 檔）。
- 5 分頁皆可切（行情/YouTube/技術/多代理/系統任務）；系統任務 tab：TW/CN 快照+MA Base+internal API 探針全綠。
- ⚠️ 健康探針只打 `/api/stock`（200），未探 `/api/stock/quote` → F2 的陸股報價間歇 404 健康頁抓不到（F2 補充）。

### 其餘頁面（快速驗證：渲染 + 無 error boundary）
| 路由 | 結果 | 重點 |
|---|---|---|
| `/sizer` 部位試算 | ✅ | 試算數學驗證全對（6張/手續費/風險48萬/0.70%）；perIndustryMaxPct=1.0 |
| `/risk` 風險面板 | ✅ | 敞口/drawdown -10.33%/集中度世芯88%/書本風險預算；跨頁資料一致 |
| `/journal` 交易日誌 | ✅(F4) | 2 筆平倉勝率100%；盈虧比 0.00 顯示問題 |
| `/realtime` 分時監控 | ✅(F5) | 週末0根正常；監控清單疑 stale |
| `/growth` 資金成長路徑 | ✅ | 7000萬→3億、🔴落後-26.3%、月份里程碑；持股3檔=TW-only 設計 |
| `/settings` 設定 | ✅ | Email通知/選股策略(Rule5不可調)/停損/掃描時間/漲跌色；與葛蘭碧±15% commit 一致 |
| `/agents/portfolio` 持股追蹤 | ✅ | 4 檔含 600487.SS；現價=進場價(週末未拉quote、按下準備檢視才更新) |
| `/agents/backtest` 回測 | ✅ | 8筆 買0/觀察6/略過2 + 各代理命中率；報酬欄「—」因樣本新 |
| `/agents/memory` 反思報告 | ✅ | §0紅線(純報告不改代理)；8份+週報 W21 |
| `/strategies/fundamental-revaluation` | ✅(O1) | 基本面補漲4維25分；Top20空待確認 |
| `/v12-performance` 14軌績效 | ✅ | 首載~28s「計算中…」後出完整表（非卡死）；B+3.24%/F 486筆等 |
| `/v12-deep-analytics` 深度分析 | ✅ | ~30s 出 Ensemble 組合勝率（B+K 75%）；非卡死 |
| `/youtube/stocks/2330` 個股時間軸 | ✅ | 30天提83次、評級演變 |
| `/diagnose/tw/2330/...` 診斷 | 🟡 F6 | 裸碼失敗、需 `.TW` |
| `/disclaimer` 免責 | ✅ | 完整條款 |
| `/mockup` 設計樣板 | ✅ | 內部 design-system 預覽 |
| `/cn-sanse` `/tw-sanse` | 404(D2) | 乾淨 404，路由已併入首頁 |

## 覆蓋總結

- **測試方式**：實際 Chrome（Claude in Chrome）打本機 :3000 prod server，逐頁 navigate + 截圖/innerText + console + network；關鍵互動（搜尋載股、試算、tab 切換、SPA 導航）實際點擊。
- **覆蓋**：app/ 全 28 路由 + 6 個 redirect stub 辨識；**未深入**：multi-agent 完整跑、掃描日期逐一切換、持倉新增/編輯/刪除/匯入匯出、暗色切換、首頁右側各掃描 tab 逐一、e2e 寫入操作（避免改到真實資料）。
- **狀態**：所有頁面皆可渲染、無白頁/崩潰；後端 API 絕大多數 200。發現 6 個 issue（F1-F6）+ 2 文件/路由觀察（D1/D2）+ 1 低優先（O1）。
- **嚴重度分布**：🟡×3（F1 hydration、F2 陸股報價flaky、F6 diagnose裸碼）、🔵×2（F3 今日建議%標籤、F4 盈虧比0.00）、⚪×4（F5/D1/D2/O1）。
- **未動任何修復**（依指示等使用者確認）。
