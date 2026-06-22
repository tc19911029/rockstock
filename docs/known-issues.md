# Known Issues — 系統問題清單

由 `/loop 幫我深挖問題` 持續挖掘記錄。每筆：日期 / 嚴重度 / 證據 / 現況。
嚴重度：🔴高（影響資料正確/選股） 🟡中（功能退化/噪音） 🟢低（小瑕疵）。

---

## 2026-06-22 第一輪：launchd cron 健康度

掃 `launchctl list | grep rockstock` 的最後 exit code，4 個 job 上次失敗：

### I-1 🔴 法人資料 stale 在 06-18 — fetch-institutional route 一直回 500（已深挖）
- **真因**：cron 15:45 平日 curl `http://localhost:3000/api/cron/fetch-institutional`（log 在 `tw-inst.log` 非 `tw-institutional`，所以一開始找不到）；route 從 06-22 起回 **HTTP 500，body `{"error":"fetch failed"}`** = 抓上游（TWSE/TPEx 三大法人端點）Node fetch 網路失敗。06-19 還正常（寫到 06-18 共 14607 筆），之後就壞。
- **資料證據**：`data/institutional/` 最新只到 **TW-2026-06-18.json**（今天 06-22）= stale 4 天。
- **影響**：籌碼面分析、題材盤後排行「法人」欄、紅旗避雷（法人連賣）全部在用舊法人資料。
- **根因假設**：使用者人在中國，台灣站（TWSE/TPEx）直連被 TLS reset（同 push2his 老問題）。若 fetch-institutional 沒走 `curlFetch` 的代理 fallback、用裸 Node fetch → 必掛。
- **待辦**：(1) 查 fetch-institutional route + provider 用的是裸 fetch 還是 curlFetch；(2) 確認 TWSE/TPEx 法人端點是否該加進 Verge DIRECT 或走代理 fallback；(3) 補回 06-19~06-22 法人資料。

### I-2 🟡 youtube-transcript 逾時（exit 28 = curl 30 分逾時）
- **證據**：`rockstock-youtube-transcript.err.log`：`curl: (28) Operation timed out after 1800076 ms`；但 .log 顯示部分影片有成功轉錄。
- **影響**：長影片 Whisper 在 in-server 跑太久撞 curl 1800s 上限 → 該批後段影片漏轉錄。已知 jetsam 搶記憶體問題（見記憶 youtube_whisper_long_m4a_fails）。
- **待辦**：確認 deferForWhisper 讓路機制是否生效、或把 curl --max-time 拉長 / 拆批。

### I-3 🟢 youtube-analysis 在「無節目日」誤判失敗（exit 1）
- **證據**：6/21(週日)無 transcript，headless claude 連 3 次「未產出 analysis」→ exit 1；morning-check log 顯示 claude 回「今天不用分析，沒有 transcript…跟我說一聲」(對話式回應、非乾淨 skip)。
- **影響**：純噪音（週末本來就沒節目），但每個無節目日都報 ❌、headless prompt 回對話而非乾淨跳過。
- **待辦**：youtube-nightly-analysis.sh 在「無 transcript」時應 early-exit 0、不重試 3 次。

### I-4 🟢 .TWO 次檔位收盤 settle 漏網（已自癒/待確認）
- **證據**：audit-l1-invariant log（06-20 09:00）`exit 1`：5 檔次檔位收盤漏網 `1538.TW / 2924.TWO / 2937.TWO / 6855.TWO / 7718.TWO`（2026-06-18）。
- **現況**：最新 health-snapshot `l1-invariant-2026-06-20.json` 顯示 violations:0 → 似已修復/自癒。audit exit=1 是警報機制正常運作（見記憶 tw_settle_subtick_close_contamination）。
- **待辦**：確認那 5 檔 06-18 的收盤現在是否已修正（repair-twoo-tail.ts）。

### I-5 🟡 audit-l1-invariant 快照停在 06-20（可能週末沒跑/停滯）
- **證據**：`data/health-snapshot/l1-invariant-*.json` 最新只到 2026-06-20，無 06-21/06-22（audit 排 09:00 平日，06-22 週一 09:00 應有）。
- **待辦**：確認 audit-l1-invariant 06-22 有沒有跑（跟 sector-strength 一樣可能排程問題）。**下一輪深挖**。

---

> 備註：prod-server exit=-9 是 `launchctl kickstart -k` 重啟的正常訊號，非錯誤。
> cn-* / youtube-scan 等 exit=0 正常。
