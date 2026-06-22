# Known Issues — 系統問題清單

由 `/loop 幫我深挖問題` 持續挖掘記錄。每筆：日期 / 嚴重度 / 證據 / 現況。
嚴重度：🔴高（影響資料正確/選股） 🟡中（功能退化/噪音） 🟢低（小瑕疵）。

---

## 2026-06-22 第一輪：launchd cron 健康度

掃 `launchctl list | grep rockstock` 的最後 exit code，4 個 job 上次失敗：

### I-1 🟡 tw-institutional cron 失敗（exit 22 = HTTP ≥400）
- **證據**：`launchctl list` 顯示 `com.rockstock.tw-institutional exit=22`；`/tmp/*institutional*` **連 log 都沒有**（job 可能沒寫 log、或 label/路徑對不上）。
- **影響**：三大法人買賣超資料抓取失敗 → 籌碼面分析、題材盤後排行「法人」欄、紅旗避雷可能用到舊資料。
- **待辦**：找出 tw-institutional plist 實際跑什麼指令、為何 HTTP 400（端點改版？被擋？）、補 log。**下一輪深挖**。

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
