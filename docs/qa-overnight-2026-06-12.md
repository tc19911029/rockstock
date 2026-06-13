# 整夜 QA 報告 — 2026-06-12（凌晨自動執行）

> 執行時段：00:25 ~ 凌晨。Chrome 未連線（瀏覽器關閉），改用 Claude Preview 瀏覽器測 :3000 prod + :3100 dev，資料驗證全走官方源 curl。

## TL;DR

| 燈號 | 項目 |
|---|---|
| 🔴→✅ | **上櫃 .TWO 06-11 整市場污染（885 檔中 883 檔錯）— 已全數用 TPEx 官方源修復並 root-cause** |
| 🔴→✅ | **上櫃歷史 volume 漂移（05-26~06-10 每天約 200~650 檔）— 已 11 個交易日全部清掃修復** |
| 🔴→✅ | **YouTube 管線從 06-10 23:00 起全斷（yt-dlp 直連 timeout）— 已改 proxy 探測 + 補抓 06-11** |
| 🔴→✅ | **ETF 06-11 揭露整晚抓不到（no source available）— 已修，補回 20 snapshots/124 tracking/共識19** |
| 🔴→✅ | **↑以上三大事故 + settle bulk=0 的「總根因」找到了：機器直連對台灣金融站會被網路層 TLS reset，手動測試因 shell proxy env 而呈現假象 — curlFetch 已加本機代理自動 fallback，系統性治癒** |
| 🟡→✅ | TW 13 檔缺 06-11（12 檔主動式 ETF + 4113.TWO）— settle 重跑已補；CN 21 檔缺K已補 |
| 🟡→✅ | 凌晨瀏覽首頁會誤存「今日(06-12) 0 檔」空掃描紀錄 — 已修 route + 刪壞紀錄 |
| ✅ | 上市 .TW 1091 檔 OHLC 06-11 對 TWSE 官方 100% 吻合；CN 抽樣 78/78 對騰訊 100% 吻合（含 volume）|
| ✅ | 指數 ^TWII 43149.46 / 上證 3987.01 與官方完全一致；000001 撞庫回歸測試通過 |
| ✅ | 全頁面巡檢 16 頁無 console error、無壞 request；tsc clean、全 Jest 套件綠、合約測試 57 套 808 tests 綠 |

---

## 一、最重大發現：上櫃 .TWO 盤後封存系統性污染

### 症狀
- audit-l1-invariant 發現 **340 檔** .TWO 最新封存收盤為次檔位偽價（57.75、49.125、124.25…）
- 對 TPEx 官方全量比對後實際更糟：**885 檔上櫃股中 883 檔的 06-11 bar 是錯的**（833 檔 close 錯 + 其餘 volume/OHL 錯）
- 典型形態：`O=H=L=C、volume=0` 的扁平殘根（純報價中間價，根本沒成交資料）
- 例：1259 安心 我們存 57.75/量0 → 官方 **59.60/量19張**（差 3.2%！）

### 根因鏈（log 證據確鑿）
06-11 14:30 `eod-settle-tw` 執行時：
1. **TWSE + TPEx 官方 bulk 全空**（`bulk size=0`，40 秒 timeout — TPEx Cloudflare 擋 + 資料未備妥）
2. **FinMind 額度已被白天其他 cron 吃到 80%，跑到第 250 檔就 402 熔斷**
3. 僅剩 vendor = Yahoo。Yahoo 的 OTC 殘值跟 L1 的盤中殘值**本是同源** → 互證「一致」
4. `skipped-already-correct` 判定**只比 close、容差 0.5%、不驗 volume、不要求官方源** → **1649 檔被誤標「已正確」**
5. T+1 早上 8 點只重驗 `pending`（157 檔）→ 那 1600+ 檔**永遠不會被複驗** = 永久污染

### 衍生發現：歷史 volume 漂移
`skipped-already-correct` 從不對賬 volume → 盤中部分量（13:33 殘值）永久留存。對官方逐日比對：
- 06-10：651 檔錯（close 對但 volume/OHL 錯為主）
- 05-26 ~ 06-09 每天約 **200~676 檔** volume/close 錯 + 每天數檔「官方無成交但我們有扁平假 bar」
- **volume 錯直接污染三色（換手率彩柱、主力中控 SUM(VOL,480)）**

### 修復（資料）
1. 新工具 [repair-two-0611-from-tpex.ts](scripts/repair-two-0611-from-tpex.ts)：抓 TPEx wn1430 官方日收盤（含 OHLC+成交股數），逐檔覆蓋不符 bar、刪「官方無成交的扁平假 bar」、官方值寫前 snap 檔位 + OHLC 自洽檢查
2. 06-11：覆蓋 875 + 刪偽根 8；06-10：覆蓋 651 + 刪 12
3. **05-26~06-09 共 11 個交易日全部清掃**（TPEx 被 Cloudflare 擋 Node fetch，改 curl 帶瀏覽器 header 抓檔 + cache 餵腳本）
4. 複驗：06-11 877/877、06-04 876/876 與官方完全一致；audit-l1-invariant TW 全綠（violations 0 / dup 0 / 次檔位 0）
5. 5906.TW（台南-KY 全額交割）：官方僅零股成交日（06-04/08/11 OHLC=`--`）的假扁平 bar 已刪
6. 0050 / 00981A 的 06-11 volume 用 TWSE 官方修正

### 修復（管線，防再發）— 改動檔案
- [lib/datasource/eodSettle.ts](lib/datasource/eodSettle.ts)：
  - SettleResult 新增 `independentAgree`（排除 L1-existing 的一致 vendor 數）+ `officialAnchor`（一致群含 TWSE/TPEx/EastMoney）
  - reconcile volume 改「官方源優先」（原本取一致群最大值，Yahoo 可能蓋過官方量）
- [scripts/eod-settle.ts](scripts/eod-settle.ts)（**TW only，CN 維持原行為**）：
  - 既有 bar 存在但 settled 無官方源/無 ≥2 獨立 vendor 背書 → 新 status `pending-unverified`（不寫、進 T+1 複驗清單）
  - `skipped-already-correct` 改精確比對 close（廢 0.5% 容差）**+ 加驗 volume**
  - `--dry` 不再覆寫正式 settle report（先前 dry 會把 cron 的 pending 清單蓋掉 → T+1 漏補，這次就踩到）
  - CN 不套新規則的原因：CN 無官方 bulk（stub）、實測常只剩騰訊一源，套了會整市場 pending + 斷宇宙外補 bar 機制（dry 實測 57/60 pending）
- [lib/datasource/eodSettleBatch.ts](lib/datasource/eodSettleBatch.ts)：bulk 抓取失敗從靜默改為記錄原因（這次 `bulk size=0` 完全無線索可查）
- 驗證：tsc clean + 合約測試綠 + **整批重跑 settle TW 06-11**：1960 檔 skipped-already-correct（官方錨+精確比對）、寫入 21（補缺 bar 的 12 檔主動式 ETF + 4113.TWO 等）、pending 16（全停牌類）
- ⚠️ settle/T+1 走 `npx tsx` 讀 working tree，**明天 14:30 起新邏輯即生效，不需 rebuild**

### 下游重算
- 06-11 台股全部掃描已用修復後資料重跑：三色（嚴3/中32/寬17，修復前寬鬆是14）、scan-tw 全字母、bm 三軌 + R 軌
- 三色 L4 歷史回補 13 個交易日（見執行紀錄）

---

## 二、YouTube 管線全斷（06-10 23:00 起）

### 症狀
/health YouTube tab 全來源「⚠ 抓取失敗」，06-11 scan-log 全部 `error: timeout`（90s），**06-11 整天節目零抓取、無 analysis**。

### 根因
與 2026-06-09 同款病徵：**Verge TUN 沒開**時 yt-dlp「直連」(--proxy '') 整批 hang（實測吊死 4 分鐘+），但 curl 直連通、本機 proxy 127.0.0.1:7897 也通（實測 yt-dlp 走 proxy 立刻成功）。程式碼當時為了 ClashX 關閉事故寫死 `--proxy ''`，兩種故障模式互斥，寫死任何一邊都會在另一邊翻車。

### 修復
- [lib/youtube/ytdlp.ts](lib/youtube/ytdlp.ts)：`ytdlpProxyArgs()` 改執行期探測 — curl 經本機代理（7897/7890）打 youtube generate_204，4 秒內通就走 proxy，否則直連；結果 cache 10 分鐘；`YTDLP_PROXY` env 仍可顯式覆寫。呼叫點 [transcript.ts](lib/youtube/transcript.ts)、[whisper.ts](lib/youtube/whisper.ts) 同步改 await。
- **已用 dev server 補抓 06-11 影片 + 字幕**（見執行紀錄）
- ⚠️ **prod 的 youtube cron 跑在 :3000 server 內，需 rebuild + 重啟才吃到新邏輯**（已於本夜執行，見部署段）
- 🔧 **根治仍是把 Verge TUN 打開**（我沒動你的 VPN 設定）— 但即使 TUN 沒開，現在管線也會自動走 proxy 不再斷

---

## 二之二、總根因：直連 TLS reset +「shell proxy env」假象（本夜最重要發現）

深挖 ETF 揭露失敗時收網：**同一個 URL 我手動 curl 都通、但 server/cron 全掛**。用 `env -i`（模擬 launchd 乾淨環境）重測 → CMoney **0.08 秒 TLS reset（curl exit 35）**、TPEx openapi **403 Cloudflare challenge**。真相：

1. 這台機器目前直連路由走中國移動（prod err.log 可見 `2409:` 開頭 IPv6 socket），對 CMoney / MoneyDJ / TPEx / YouTube 等站**直連會被網路層切斷**
2. 我的互動 shell 有 `HTTPS_PROXY=127.0.0.1:7897`（Verge）→ **整夜所有「手動測試成功」其實都默默走了代理**＝假象
3. launchd 起的 prod server / cron 沒有 proxy env → 真直連 → 全滅

這一條同時解釋：06-11 14:30 settle `bulk size=0`、ETF 整晚 no source、yt-dlp 全 timeout、TPEx 擋「Node fetch」的表象。

**系統性修復**（[lib/datasource/curlFetch.ts](lib/datasource/curlFetch.ts)）：
- `execCurlWithProxyFallback`：curl 直連失敗 → 依序帶 `-x` 試本機代理（7897 Verge / 7890 ClashX），成功者 cache 10 分鐘；代理都沒開時行為與原版相同（不依賴 env、Verge 關掉自動退回直連）
- 補 `-f`：curl 對 HTTP 403 預設 exit 0，challenge HTML 會被當「成功」進 JSON.parse，代理重試永不觸發——必須 -f 才會走 fallback
- 治癒範圍：所有走 `fetchJsonWithCurlFallback` / `fetchBufferWithCurlFallback` 的鏈（**TPEx/TWSE settle bulk、ETF、ISIN**…）
- 乾淨環境驗證：TPEx bulk 994 / TWSE bulk 1355 / CMoney 50 檔持股 全通 ✅

**ETF 修復**（[lib/etf/holdingsSource.ts](lib/etf/holdingsSource.ts)）：CMoney/MoneyDJ 從裸 Node fetch 改走 curlFetch fallback、catch 不再靜默吞錯。修後 prod 立即補回 **06-11：20 snapshots / 20 diffs / 124 tracking entries / 共識 19、零錯誤**。

**殘餘風險**：FinMind / Yahoo / EODHD 仍走裸 Node fetch（目前直連可通）；若再出現「server 掛、手動通」同病徵，把該 provider 換 curlFetch 即可（已寫進 memory）。

## 三、其他修復

| 問題 | 根因 | 修復 |
|---|---|---|
| 凌晨瀏覽首頁 → /health 顯示「最近掃描 06-12 (0 檔)」誤導 | 首頁 scan panel 自動 `POST /api/scanner/backfill`，route 沒有「今天還沒收盤」守門，凌晨就把 06-12 當盤後掃出 0 檔存檔 | [app/api/scanner/backfill/route.ts](app/api/scanner/backfill/route.ts) 加 pre-market 守門（TW<14:30 / CN<15:30 拒掃今天、未來日期一律擋）+ 已刪兩筆壞紀錄。**需 rebuild 生效** |
| audit 誤報 ^TWII 43149.46 為次檔位 | 指數沒有股票檔位規則 | [scripts/audit-l1-invariant.ts](scripts/audit-l1-invariant.ts) 排除 `^` 開頭 |
| TW 12 檔主動式 ETF（00984A~00995A）+ 4113.TWO 缺 06-11 | 06-11 settle 降級（同事件一）拿不到資料 | settle 重跑自動補齊（值=官方）|
| CN 9 檔卡 06-10 | 下載缺口 | backfill-cn-gaps 補 21 檔；其餘 36 檔 vendor 也無資料=停牌/下市 |

## 四、查證後「不是 bug」的項目

- **L2 status=missing（凌晨）**：health 查的是「今天 06-12」的盤中快照，開盤前本來就不存在；06-11 快照完好。
- **CN downloadFailed:100**：failedSymbols 全是早已下市的老 A 股（600001 邯鄲鋼鐵、600002 齊魯石化、000003 PT金田…），長期掛在 cn_stocklist 的慢性噪音，非當日事故。
- **TW 15 檔 / CN 39 檔缺 06-11**：逐檔對官方名單驗證，全部是停牌/下市/當日無成交（1435、1589 TWSE 確認 6 月零資料；5906 僅零股）。
- **dev(:3100) 看到 quote 請求風暴（~4次/秒）**：prod 實測 66 秒僅 4 次（正常 30s 輪詢），是 dev StrictMode/HMR 疊加，非 prod 問題。
- **/risk 起點 NT$76.0M**：來自 growth-path 設定（7000萬→3億），與 /growth 一致。
- **三色掃描結果變動（寬鬆 14→17）**：上櫃資料修復後的正確結果，非異常。

## 五、頁面巡檢矩陣（全部通過）

| 頁面 | 結果 | 備註 |
|---|---|---|
| `/`（^TWII 預設） | ✅ | 06-11 43149.46=官方；三色/掃描/條件面板全載入 |
| `/?load=2330 / 1259(.TWO) / 600519 / 000001.SS` | ✅ | OHLCV 全對官方/騰訊；中文名正常 |
| 000001.SS 撞庫回歸（觀察 75s+輪詢） | ✅ | 不再變平安銀行 |
| `/?load=2330&date=2026-05-15`（asOf 走圖） | ✅ | 凍結正確、無今日注入 |
| `/watchlist` `/etf` `/realtime` `/backtest/leaderboard` | ✅ | leaderboard 是你的 WIP 區，渲染與資料正常 |
| `/portfolio` `/sizer` `/risk` `/journal` `/growth` | ✅ | 持倉讀 server 真相；3006 收盤 204.5=官方 |
| `/health`（行情/YouTube/系統任務 tab） | ✅ | YouTube tab 紅燈即本夜事件二，已處理 |
| `/agents/2330.TW`、`/agents/pool`、`/youtube`、`/settings` | ✅ | redirect 正常、無 404 |

console error：0（youtube/trends 的 ERR_ABORTED 為元件卸載取消，端點 curl 200/9ms）。

## 六、小問題（已記錄未修，影響低）

1. **凌晨 .TWO/CN 走圖會顯示一根「今日(06-12) ▲0.00 扁平 bar」**：盤前報價注入鏈把昨收當今日 bar 顯示（.TW 走 TWSE 路徑沒有此現象）。純顯示層、開盤後自癒。建議：注入 gate 交易時段。
2. `/api/chip` 冷載 15s、`/api/cost-basis` 冷載 20s（外部源即抓即算）。

## 七、優化提案（等你確認，未動手）

1. **cn_stocklist 清理 ~100 檔已下市老股**（每日 downloadFailed 噪音 + audit 覆蓋率紅線誤觸）：建議併入 permanent-stale registry 或直接從清單移除。
2. **settle 時程**：TW 14:30 常拿不到 TPEx bulk（Cloudflare/未發布）。建議 eod-settle-tw 改 15:30 或加 16:30 第二輪；或 bulk 失敗時自動 1 小時後重試一次。
3. **FinMind 額度預算管理**：settle 前額度已被吃到 80%。建議把 settle 需要的額度保留下來（白天 cron 限流），或 settle 完全改吃官方 bulk（已部分達成）。
4. **TPEx 抓取統一走 curl**：Cloudflare 擋 Node fetch TLS 指紋、curl 帶瀏覽器 header 可過。`fetchJsonWithCurlFallback` 已有 curl fallback，但建議 TPEx 端點直接 curl-first + 帶 Referer。
5. **L2 health 凌晨顯示**：開盤前 fallback 顯示前一交易日快照 + `pre-market` 狀態，避免每天早上看到 missing。
6. **chip/cost-basis 預熱**：對持倉+自選股每日盤後 cron 預抓，消除 15-20s 冷載。
7. **歷史更深的 .TWO volume 漂移**（05-26 以前）：同款問題大概率存在。可用同工具往回掃（TPEx 限流，建議每天清 2 週、分數晚完成），或一次寫 launchd 慢速清整年。
8. **audit-l1-last-day 整合停牌 registry**：99% 紅線把停牌算進去，每天 exit 1 誤報。
9. **凌晨合成今日 bar**（小問題 #1 的修復授權）。

## 八、待決事項

1. **/portfolio 現金 NT$0、總資產 5.52M vs 成長路徑起點 76M（紅燈 -94%）**：頁面功能正常，但這個資料狀態是否符合你的實際？（profile=me 只剩 3006 一檔持倉）
2. **06-11 的 bm 字母掃描歷史（05-26~06-10）**未重跑：買法主要靠價格形態，受 volume 修復影響較小，且全量重跑 11 天 ×5 軌成本高。三色 L4 已全部重算。要補可說一聲。
3. **Verge TUN 目前是關的**：yt-dlp 已改為自動走 proxy 不受影響，但若你希望恢復「直連」模式，要手動開 TUN。

## 九、執行紀錄 / 改動檔案清單（均未 commit）

**程式（9 檔改 + 1 新增，prod 已含全部修復重建並重啟）**
- `lib/datasource/curlFetch.ts` — **本機代理自動 fallback + `-f`（總根因修復）**
- `lib/etf/holdingsSource.ts` — CMoney/MoneyDJ 走 curlFetch + 不再靜默吞錯
- `lib/datasource/eodSettle.ts` — independentAgree/officialAnchor + 官方 volume 優先
- `scripts/eod-settle.ts` — pending-unverified（TW only）+ 精確比對 + volume 驗證 + dry 不覆寫報告
- `lib/datasource/eodSettleBatch.ts` — bulk 失敗記錄原因
- `app/api/scanner/backfill/route.ts` — pre-market 守門
- `lib/youtube/ytdlp.ts` + `transcript.ts` + `whisper.ts` — proxy 探測
- `scripts/audit-l1-invariant.ts` — 排除指數
- `scripts/audit-l1-daily-change.ts` 等 17 支腳本 — 清掉寫死的舊 Mac 路徑（/Users/tzu-chienhsu，新機 EACCES）
- `scripts/repair-two-0611-from-tpex.ts` — 新增（可重複使用：`--date` + `--cache`）

**資料修復**
- .TWO：06-11×883、06-10×663、05-26~06-09 每日 ~200-680（合計約 4,000+ bar 修正/刪除）
- 5906.TW×3、0050/00981A volume×2、CN 缺K×21
- 刪 2 筆 06-12 凌晨壞掃描紀錄
- 06-11 台股掃描全鏈重跑（三色+全字母+三軌+R）
- 三色 L4 回補 13 交易日
- YouTube 06-11 影片補抓 + 字幕

**測試**：tsc clean / npm test 全綠（exit 0）/ 合約 57 套 808 tests 綠

## 十、部署與最終驗證（已完成）

- `npm run build` 成功（含你的 broker WIP 一併編譯，無錯；夜間共 build 3 次，最終版含全部修復）→ `launchctl kickstart -k` 重啟 :3000 prod（無 yt 子程序受影響、`DISABLE_LOCAL_CRON` 無殘留）
- 重啟後驗證：root 200/2ms、`/api/stock` 2330 回修復後正確資料、1259 安心走圖顯示官方值（59.60/量19張）
- **pre-market 守門 live 驗證**：`POST /api/scanner/backfill {date:2026-06-12}` → `skipped: today post_close not sealed yet` ✅（01:25 舊 build 又寫過一次 06-12 空紀錄，已刪；新守門擋住復發）
- `npm run smoke`：**9/9 pass**
- `/api/health/data`：TW good（覆蓋率 100%、L4 最新=06-11）、CN good（96.9%，缺口=停牌長尾）
- 最終 `audit-l1-invariant` 雙市場：**violations 0 / 整根複製 0 / 次檔位 0 全綠**

### .TWO 清掃逐日明細（覆蓋根數）
06-11: 875+刪8 ｜ 06-10: 651+刪12 ｜ 06-09: 427 ｜ 06-08: 498+刪7 ｜ 06-05: 190+刪8 ｜ 06-04: 345+刪10 ｜ 06-03: 206+刪4 ｜ 06-02: 203+刪8 ｜ 06-01: 221+刪8 ｜ 05-29: 212+刪5 ｜ 05-28: 248+刪4 ｜ 05-27: 236+刪9 ｜ 05-26: 235+刪8 ｜ 另刪「官方無成交但 L1 有整根複製 bar」7 根（4406/4413/4728/6721/8923）
**合計：修正 ~4,547 根、刪偽根 ~98 根**；06-04/06-11 複驗 100% 吻合官方

### 三色 L4 回補（修復後重算）
13 個交易日全部重算固化（05-26~06-11），例：06-09 嚴10/中47/寬37/共振270、06-11 嚴3/中32/寬17/共振95

### YouTube 06-11 補抓
影片 14 支/12 來源已補齊（錢線上中下、理財達人秀、兆華艾綸、金融曼哈頓…）；字幕背景補抓中（無字幕來源走 Whisper，較慢）— 若你起床時 analysis 還沒生，跑 `/youtube-analysis` 即可（question payload 會等字幕完成後自動 prepare）

---

## 九、第二波（06-12 上午）：優化全面執行紀錄

使用者拍板「全部按你說的去做」，以下全部完成並部署：

### 賺錢優先層
| # | 項目 | 落地 | 驗證 |
|---|---|---|---|
| A1 | 停損/賣訊手機推播 | `/api/cron/portfolio-notify`（local-cron 每 2 分）＋13:18-13:30 執行窗再提醒「13:25 掛市價」；涵蓋所有持倉人 profiles | tsc/contracts 綠 |
| A2 | 紀律影子帳本 | `lib/portfolio/shadowLedger.ts` + `/api/portfolio/shadow` + /portfolio 卡片 | 3006 實測：影子 06-05 @222.5 停損全出，**紀律差額 +NT$114,750** |
| A3 | 賣訊實證輕重 | `lib/sell/sellHeavinessRank.ts`（讀 sell-heaviness.json 動態分級）接進推播訊息 🔴🟠⚪ | 死叉=輕(0.01)、捕撈死叉=重(0.49) 對齊回測 |
| B1 | 13:25 進場回測對齊 | `metricsFromLocalCandles` 加 `entryMode=next_close`（隔日收盤≈13:25 市價）；`ENTRY_MODE=next_close` 跑 TW 480d 變體 → `strategy-leaderboard-c1325.json` | 5 天探針通過；正式 run 背景進行 |
| B2 | Paper-trade 追蹤 | `/api/cron/paper-track`（19:05 launchd）：⭐全共振+應買top3 自動開單、隔日收盤進場、書本規則出場；`/backtest/leaderboard` 顯示「若照系統做」卡 | 首跑開 9 筆 06-11 訊號單 |
| B3 | 來源歸因回測 | `scripts/backtest-source-attribution.ts` → `data/backtest-output/source-attribution-2026-06-12.md` | **youtube A/B 評級 d5 +2.29%（raw bullish -2.47% → 9 維評分有效）；pool 基本面 +3.91%、3 源共識 +3.33% 勝率 62.5%；法人看多股 d5 -8.82% 勝率 0%（本窗反指標）**；窗口僅 ~3 週，方向參考 |
| C1 | 今日最優先卡 | `TodayTopPriorityCard`（scan tab 頂）：動態讀排行榜最強策略×排序＋今日命中 top3＋13:25 提醒；無命中誠實顯示「別硬做」 | dev 實測渲染正確（最強=三色點火🔥+雙指標×漲幅 d5+2.25%） |
| C2 | sizer 一鍵試算 | /sizer 支援 query 預填；最優先卡每檔附「📐 試算」連結 | tsc 綠 |

### 基礎設施 9 條（第七章提案全執行）
1. ✅ cn_stocklist 清 116 檔殭屍（3134→3018；騰訊日K末根權威判死；`cn-delisted-removed.json` 留痕 + 生成器接排除清單防復活）
2. ✅ eod-settle-tw 加 16:30 第二輪（plist 14:30+16:30 ×5 天）
3. ✅ settle 有官方 bulk 錨時跳過 FinMind（省 ~2000 配額/輪）
4. ✅ TPEx 域名 curl-first + 自動補 Referer（集中在 curlFetch）
5. ✅ /health L2 開盤前顯示 `pre-market`（fallback 前一交易日快照）
6. ✅ prewarm-chip cron 18:10（持倉人聯集，消除 15-20s 冷載）
7. ✅ .TWO 歷史 volume 慢速清掃 launchd 03:00（每晚 12 交易日、回掃至 2024-06-01 自動停，`~/.local/bin/rockstock-two-sweep.sh`）
8. ✅ audit-l1-last-day 新鮮故障/慢性停牌分離（紅線只算 7 日內新缺；exit 0）
9. ✅ 凌晨合成今日 bar gate（replayStore 開盤前不 push 假 bar）

### 新增 launchd
`com.rockstock.two-volume-sweep`(03:00)、`com.rockstock.prewarm-chip`(18:10)、`com.rockstock.paper-track`(19:05)；`eod-settle-tw` 改雙輪。
