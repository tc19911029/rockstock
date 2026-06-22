# Known Issues — 系統問題清單

由 `/loop 幫我深挖問題` 持續挖掘記錄。每筆：日期 / 嚴重度 / 證據 / 現況。
嚴重度：🔴高（影響資料正確/選股） 🟡中（功能退化/噪音） 🟢低（小瑕疵）。

---

## 2026-06-22 第一輪：launchd cron 健康度

掃 `launchctl list | grep rockstock` 的最後 exit code，4 個 job 上次失敗：

### I-1 ✅ RESOLVED — fetch-institutional 裸 fetch → curlFetch（2026-06-22 修）
- **修法**：`lib/datasource/TWSEInstitutional.ts` 裸 `fetch(www.twse.com.tw)` → `fetchJsonWithCurlFallback`
  （直連 TLS reset 時自動帶本機代理 fallback）。驗證：force 重抓 06-18 回 `count:14607`，500 消失。
- **澄清**：「卡在 06-18」其實正常——**06-19 是端午節非交易日** + 週末，06-18 本就是最後交易日。
  06-22(今日) TWSE T86 回「查詢日期小於101/05/02」= TWSE 端無該日資料（疑此環境時鐘超前真實 TWSE），
  非連線 bug；cron 每日會自動補上。
- **原始紀錄（保留）**：
- **真因**：cron 15:45 平日 curl `http://localhost:3000/api/cron/fetch-institutional`（log 在 `tw-inst.log` 非 `tw-institutional`，所以一開始找不到）；route 從 06-22 起回 **HTTP 500，body `{"error":"fetch failed"}`** = 抓上游（TWSE/TPEx 三大法人端點）Node fetch 網路失敗。06-19 還正常（寫到 06-18 共 14607 筆），之後就壞。
- **資料證據**：`data/institutional/` 最新只到 **TW-2026-06-18.json**（今天 06-22）= stale 4 天。
- **影響**：籌碼面分析、題材盤後排行「法人」欄、紅旗避雷（法人連賣）全部在用舊法人資料。
- **根因假設**：使用者人在中國，台灣站（TWSE/TPEx）直連被 TLS reset（同 push2his 老問題）。若 fetch-institutional 沒走 `curlFetch` 的代理 fallback、用裸 Node fetch → 必掛。
- **待辦**：(1) 查 fetch-institutional route + provider 用的是裸 fetch 還是 curlFetch；(2) 確認 TWSE/TPEx 法人端點是否該加進 Verge DIRECT 或走代理 fallback；(3) 補回 06-19~06-22 法人資料。

### I-2 ✅ MITIGATED — youtube-transcript curl 逾時（2026-06-22）
- **修法**：plist `--max-time 1800 → 2700`（45 分，仍 < 60 分 hourly 間隔不重疊）。且本來就部分自癒——每小時跑一次、route idempotent，逾時批次下一輪會補。
- **原始**：
- **證據**：`rockstock-youtube-transcript.err.log`：`curl: (28) Operation timed out after 1800076 ms`；但 .log 顯示部分影片有成功轉錄。
- **影響**：長影片 Whisper 在 in-server 跑太久撞 curl 1800s 上限 → 該批後段影片漏轉錄。已知 jetsam 搶記憶體問題（見記憶 youtube_whisper_long_m4a_fails）。
- **待辦**：確認 deferForWhisper 讓路機制是否生效、或把 curl --max-time 拉長 / 拆批。

### I-3 ✅ FIXED — youtube-analysis 無節目日誤報（2026-06-22）
- **修法**：`~/.local/bin/rockstock-youtube-nightly-analysis.sh` 加 guard：`data/youtube/transcripts/$D` 為空就 `exit 0` 乾淨跳過，不叫 claude 硬撐 3 次。
- **原始**：
- **證據**：6/21(週日)無 transcript，headless claude 連 3 次「未產出 analysis」→ exit 1；morning-check log 顯示 claude 回「今天不用分析，沒有 transcript…跟我說一聲」(對話式回應、非乾淨 skip)。
- **影響**：純噪音（週末本來就沒節目），但每個無節目日都報 ❌、headless prompt 回對話而非乾淨跳過。
- **待辦**：youtube-nightly-analysis.sh 在「無 transcript」時應 early-exit 0、不重試 3 次。

### I-4 ✅ REPAIRED（單根）+ 系統性累犯（2026-06-22）
- **現況**：5 檔中 4 檔已自癒；**6855.TWO 06-22 收盤 121.75（次檔位，TPEx 官方=121.00）**已直接修正 L1（只有 close 錯、OHLC 本對）。
- **系統性**：.TWO settle 偶爾把 close snap 成次檔位（FinMind 402 退 Yahoo 中間價，見記憶 tw_settle_subtick_close_contamination）；audit（I-5 修好後週一也會跑）會持續抓，根因修復屬另案。
- **原始**：
- **證據**：audit-l1-invariant log（06-20 09:00）`exit 1`：5 檔次檔位收盤漏網 `1538.TW / 2924.TWO / 2937.TWO / 6855.TWO / 7718.TWO`（2026-06-18）。
- **現況**：最新 health-snapshot `l1-invariant-2026-06-20.json` 顯示 violations:0 → 似已修復/自癒。audit exit=1 是警報機制正常運作（見記憶 tw_settle_subtick_close_contamination）。
- **待辦**：確認那 5 檔 06-18 的收盤現在是否已修正（repair-twoo-tail.ts）。

### I-5 ✅ FIXED — audit-l1 plist Weekday off-by-one（2026-06-22）
- **真因**：plist 排 Weekday **2-6（週二到週六）、漏週一(1)、多週六**→ 週一 audit 從沒跑（06-22 無快照）。
- **修法**：改 Weekday 1-5（週一到週五）09:00 並 reload。
- **原始**：
- **證據**：`data/health-snapshot/l1-invariant-*.json` 最新只到 2026-06-20，無 06-21/06-22（audit 排 09:00 平日，06-22 週一 09:00 應有）。
- **待辦**：確認 audit-l1-invariant 06-22 有沒有跑（跟 sector-strength 一樣可能排程問題）。**下一輪深挖**。

---

> 備註：prod-server exit=-9 是 `launchctl kickstart -k` 重啟的正常訊號，非錯誤。
> cn-* / youtube-scan 等 exit=0 正常。

---

## 2026-06-22 第二輪：裸-fetch 連線地雷掃描 + 排名邏輯查核

### I-6 ✅ 無其他「裸 fetch + 台灣站」地雷（掃描結論）
- 從 I-1 學到「裸 Node fetch 打 TWSE/TPEx/Yahoo 在中國線路 TLS reset」是一整類風險。
- 系統掃 `lib/datasource|chips|storage|market` 所有打 twse/tpex/yahoo/goodinfo… 的檔，
  交叉比對有沒有走 curlFetch → **沒有漏網的**。I-1（TWSEInstitutional）是唯一個案，已修。

### I-7 ✅ FIXED — themeRotation 過時註解（avgD5 → 法人資金流入5日）
- **真相**：盤後排行的「排名」= `rankByMoneyIn` = **近 5 日三大法人買超金額**（成分股加總）由高到低，
  代表「這週法人在累積哪個題材」。2026-06-19 從今日漲幅改成資金流入、06-20 改看 5 日累計。
- **bug**：檔頭(line 9) + rankNow 欄位(line 26) 註解還寫「依 avgD5 排」→ 誤導。已修正（commit 52f9d56）。
- **附帶澄清**：snapshot 檔預設 avgD5 排序、UI FixedView 預設 'd5'，但點「排名」欄走 rankNow(法人5日)。

---

## 2026-06-22 第三輪：cron 實際產出新鮮度 + 殘留壞 import

### I-8 ✅ 非問題 — theme-sanse/hot「殘留 import」是虛驚
- `app/api/theme-sanse/hot/route.ts` import `lib/theme-sanse/{hotThemes,codeThemes,types}` — 這三檔**都還在**
  （cn-agents/題材三色刪除只刪部分；TW theme-sanse 刻意保留）。route 回 400=缺參數、可跑，非壞 route。

### I-9 ✅ 資料「停滯」多為預期（非 cron 故障）
- 法人 06-18 = 端午放假（I-1 已釐清）；題材排名/健康快照 06-22 fresh ✓（sector-strength cron 修生效）。
- 券商報告 06-16、估值 06-10 = **skill 手動產出**（broker-analysis / valuation skill，非 cron），屬正常非停滯。

### I-10 🟡 待查 — scan-fundamental-revaluation-tw cron 無 log
- plist 排平日 19:35，但 `/tmp/rockstock-scan-fundamental-revaluation-tw*.log` **找不到** → 可能 log 路徑不同 or 沒真的跑。
- **下一輪深挖**：確認該 cron 是否真有產出 `data/strategies/fundamental-revaluation/TW/`。
