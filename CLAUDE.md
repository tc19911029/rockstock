@AGENTS.md

## Fundamental Requirements（不可覆寫）

**必讀**: 任何修改前必須先閱讀 [docs/FUNDAMENTAL_REQUIREMENTS.md](docs/FUNDAMENTAL_REQUIREMENTS.md)

以下規則不可因任何新需求而違反：

1. **歷史日K封存後不可被盤中資料覆蓋** — Layer 1 與 Layer 2 完全分離
2. **掃描紀錄必須用複合主鍵** — `market + strategy + trade_date + session_type + scan_timestamp`，不同日期不互相覆蓋
3. **全市場掃描必須使用快照粗掃** — 不可逐檔讀取 Blob（會導致 Vercel 超時）
4. **走圖/持倉更新必須獨立於掃描資料流** — Layer 3 與 Layer 2 分開
5. **選股條件只用書本規則**（六條件+戒律+淘汰法），不加自創因子
6. **API 分工由底層設計** — 不可因新功能改變 Provider 路由策略
7. **任何修改必須先通過合約測試** — `npm run test:contracts`
8. **不可刪除或修改 `lib/contracts/` 下的檔案**
9. **開發順序**：資料來源 → 儲存方式 → 掃描鏈路 → 前端顯示，不可反過來
10. **選股邏輯單一事實**：六條件、戒律、淘汰法、MTF 過濾、排序因子、門檻值必須從 `lib/selection/applyPanelFilter.ts` + `lib/strategy/StrategyConfig.ts` 讀取，**不可 hard-code 於 UI、store、回測腳本**。改動時同時更新：
    - `lib/scanner/ScanPipeline.ts` / `MarketScanner.ts`（生產）
    - `store/backtestStore.ts`（前端 UI 過濾）
    - `scripts/backtest-*.ts`（回測腳本）
    - `__tests__/contracts/scan-parity.test.ts`（交叉驗證）
    並跑 `npm run test:contracts` 確認三方一致。

## 資料分層架構

```
Layer 1: 歷史日K主資料庫（封存後不可變）
Layer 2: 盤中即時快取層（全市場快照，單一檔案）
Layer 3: 個股高頻走圖層（走圖+持倉，最多20檔）
Layer 4: 掃描結果層（複合主鍵，intraday vs post_close）
```

## 兩級掃描

```
粗掃: 讀 Layer 2 全市場快照 → 幾十檔候選（< 3 秒）
精掃: 候選池讀 Blob 歷史K線 → 六條件+戒律+淘汰法（< 30 秒）
```

## v12 字母 cron 分軌架構（0513 ABCDE E）

買法掃描走「軌道分批」（不再一字母一 cron）：

```
盤後 post_close：/api/cron/scan-bm-batch?market=X&track=Y
盤中 intraday：  /api/cron/update-intraday-bm-batch?market=X&track=Y
```

三軌（lib/scanner/buyMethodTracks.ts 單一事實來源）：
- **bullish**: B/C/E/J/K/L/M/P（過 Step 1 池子）
- **reversal**: D/F/N/O（全市場掃，不過 Step 1）
- **system**: Q（戰法軌，過 Step 0 大盤但不過 Step 1）

同 track 內字母共用 stockList / L2 / TurnoverRank / marketTrend / Step 1 池子，
比舊版（一字母一 cron）省 ~5-7 倍前置時間。vercel.json cron 從 ~42 條 → 12 條。

> 加新字母 / 改 track 分流必須同步更新 buyMethodTracks.ts + scan-parity 合約測試。

## 溝通慣例

- **時區永遠是台灣 (CST, UTC+8)**。對話、log、cron 排程討論一律用 CST，不寫 UTC。
  - 例：15:45 CST 而非 07:45 UTC。
  - 注意 `fetchedAt` 等 ISO 字串底層是 UTC，**讀取時務必 +8h** 才是台灣時間（曾因此誤判 0505 凌晨 01:14 抓到的 mislabel snapshot）。
  - `vercel.json` cron 表達式是 UTC（Vercel 平台規定），例如 `"0 10 * * 1-5"` = CST 18:00。
  - 本地 launchd plist 的 Hour 是機器 local time，台灣機器直接寫 CST 數字（18 = 18:00 CST）。

## YouTube 理財節目追蹤（MVP 1-5：抓得穩 → 讀得準 → 八面資料 → 9 維評分）

**架構決議**：分析不靠程式呼叫 Anthropic SDK，走 [zhu](file:///Users/tc/.claude/commands/zhu.md) 同款檔案橋接 pattern — 程式只負責「把資料整理乾淨寫成 question payload」，使用者開 Claude Code 對話用 `/youtube-analysis` skill 讓對話中的 Claude 讀檔分析、寫 answer，成本走訂閱不走 API。

- **資料路徑**：`data/youtube/`（dual-storage：本地 FS + Vercel Blob `youtube/` prefix）
  - `sources.json` — 6 來源 registry（seed-or-load）
  - `videos/{YYYY-MM-DD}.json` — 該日掃到的所有影片
  - `scan-logs/{YYYY-MM-DD}.json` — 該日每來源掃描結果
  - `video-index.json` — 全域 `video_id → {date, source_id}` dedup 索引
  - `health.json` — 來源健康滾動快照
  - `transcripts/{YYYY-MM-DD}/{video_id}.json` — 完整逐字稿 + cues + 品質分數
  - `transcript-index.json` — 全域 transcript metadata 索引
  - `analysis/{YYYY-MM-DD}.json` — **Claude（在對話內）寫的 DailyAnalysis** (`market_view + consensus + stocks`)
  - `stock-master.json` — TWSE+TPEx code↔name 對照（7 天 TTL，~26K entries）
- **暫存區（不持久化）**：`/tmp/rockstock-youtube/{date}-question.json` — 程式產出，給 skill 讀
- **三段式 cron 流水線**（全部走 launchd → curl localhost，不上 Vercel）：
  - **盤後主批 19:00 / 19:30 / 20:15 CST**：抓 14:54-18:30 大宗節目 + 早班批
  - **晚間補抓 23:45 / 00:15 / 01:00 CST**：補抓兆華艾綸 21:30 + 錢線百分百 23:30
  1. `com.rockstock.youtube-scan` → `yt-dlp --dump-json --skip-download --playlist-end 30`
  2. `com.rockstock.youtube-transcript?use_whisper=1` → 先抓 yt-dlp 人工字幕，無字幕來源 fallback Whisper 音轉文字
  3. `com.rockstock.youtube-prepare-analysis` → 寫 question payload 到 /tmp（**不打 LLM**）
- **嚴格同日過濾**（2026-05-22 加）：所有 cron route 接受 `?date=YYYY-MM-DD`，published_at 必須落在該日 Asia/Taipei 才 should_analyze=true，否則 `skip_reason='wrong_date'`。不帶 `?date=` → fallback 72h 窗（向下相容）。Backfill 用法：`?date=2026-05-21&force=1`
- **Whisper 配置**（faster-whisper + medium model）：
  - 安裝：`python3 -m pip install --user faster-whisper`（首次 1.5GB model 下載到 `~/.cache/huggingface`）
  - 速度：M-series CPU 約 2x realtime（25min 影片 ~12min 處理）
  - 觸發：transcript cron 加 `?use_whisper=1` 時，無字幕影片 fallback 到 Whisper
  - 補回機制：existing transcript status=unavailable/failed + use_whisper=1 → 自動 retry（不再 sticky）
- **yt-dlp 版本要求**：≥ 2026.03.17（舊版 player_client=web 在新 YouTube 環境會 403/format-not-found；新版自動挑 android_vr/mediaconnect 等可用 client）
- **Index 寫盤策略**（2026-05-22 bugfix）：transcript cron 每處理完一支立即寫 `transcript-index.json`（不再等迴圈結束才寫），避免長 Whisper backfill 中斷時 index 落後實際檔案。修補 stale index：`npx tsx scripts/rebuild-transcript-index.ts`
- **多 cron 並行陷阱**：手動 kill curl 不會停掉 Next.js dev server 內已開始的 cron 請求 — server 會繼續跑、spawn 更多 yt-dlp/ffmpeg/whisper 子程序。要中斷必須 `launchctl kickstart -k gui/$(id -u)/com.rockstock.dev-server` 重啟 dev server，或 `pkill -9 -f yt-dlp` + `pkill -9 -f whisper` + 等 cron 自然超時
- **分析**：使用者在 Claude Code 對話輸入 `/youtube-analysis`（位於 `~/.claude/commands/youtube-analysis.md`）→ skill 讀 question.json → Claude 寫 `data/youtube/analysis/{date}.json`
- **股票匹配**：`lookupStock(query)` 走 5 段 fallback（純數字代號 → ALIAS_MAP → 全名 → prefix → substring），回 `confidence ∈ [0, 1]`
- **彙整門檻**：`deriveStockMentions(analysis)` 只列入 `matched != null` 且 `combined_confidence ≥ 0.6`
- **為何不上 Vercel cron / 為何不打 SDK**：(1) yt-dlp 是系統 binary，serverless 跑不動 (2) 分析走訂閱模式更靈活、能用 Opus、能即時修 prompt
- **前端**：`/youtube`（紅綠燈卡 + 今日跨節目共識區 + 今日提到股票表 + 影片表含「逐字稿」「稿品質」欄）
- **規則** (合約測試保證)：
  - should_analyze=false ⇒ 必有 skip_reason
  - transcript status=unavailable ⇒ score=0
  - transcript status=available ⇒ quality_score ≥ 50
  - deriveStockMentions 進入彙整的股票 ⇒ matched != null 且 combined_confidence ≥ 0.6
  - questionBuilder.videos 只含 transcript_status=available 的影片
- **八大面向資料**（MVP 4，`lib/youtube/stockDataLoader.ts`）：
  - technical / chip / fundamental / news → 本地 internal API（`/api/stock`、`/api/chip`、`/api/fundamentals`、`/api/news`）
  - industry → FinMind `TaiwanStockInfo`（產業類別、market_type）
  - governance → FinMind `TaiwanStockShareholding`（外資持股比率 + 4 週變化，FinMind 免費層無「大戶分級」與「內部人交易」）
  - macro → `/api/stock?symbol=^TWII/^TWOII/^IXIC`（市場 regime: 多頭/盤整/空頭）
- **9 維 factor scoring**（MVP 5，`lib/youtube/analysisStorage.ts`）：權重總和=100
  - technical 25, chip 18, fundamental 15, news 12, mention_heat 10, industry 10, macro 5, valuation 3, governance 2
  - `computeCompositeScore(FactorScores)` → 0-100；`ratingFromScore(s)` → A≥75 / B≥60 / C≥45 / D<45
  - skill 文件（`~/.claude/commands/youtube-analysis.md`）有每維 0-100 評分準則 + 計分公式
- **API**：`/api/youtube/{health,sources,videos,stocks}`、`/api/youtube/transcripts/[video_id]`、`/api/youtube/analysis/[date]`
- **環境變數**：`CRON_SECRET` (cron route auth)；可選 `FINMIND_API_TOKEN`；**不需要 `ANTHROPIC_API_KEY`**

## 健康監控（0513 ABCDE E）

- **資料健康狀態頁**：`/health`（L1 覆蓋率 / L2 fresh / L4 scan / limit-up consistency 紅綠燈）
- **每日快照 cron**：`/api/cron/daily-health-snapshot`（盤後固化到 `data/health-snapshot/`）
- **Webhook 警示**：紅燈時 POST 到 `HEALTH_ALERT_WEBHOOK_URL`（env 設定即啟用；
  Slack/Discord/ntfy.sh 都吃；payload = `{ text, level, dateKey, markets }`）
- **L1 invariant 每日 audit**：`scripts/audit-l1-invariant.ts` + launchd plist
  09:00 CST 自動跑（>100 violations 自動 alert）

## 測試金字塔

```
762 unit tests (Jest)        — detector / SOP / store
 17 contract tests           — scan-parity / cross-source
 16 e2e tests (Playwright)   — chart locked / lockwatch flow / hydration
─────────────────────────────
795 total, tsc clean, 全綠
```

- `npm test`：跑全部 Jest 單元 + 合約測試
- `npm run test:contracts`：只跑合約（最快）
- `npm run test:e2e`：跑 Playwright（需 dev server 已起）
- `npm run smoke`：server-side smoke test（9 paths）

## ETF 持股資料規則（避免 mislabel）

主動式 ETF 揭露時間：盤後 17:00-21:00 CST。**禁止在揭露時間前抓資料寫成「當日」snapshot**：

- `disclosureDate` **必須**用資料源回傳的日期欄位（CMoney row[0]、MoneyDJ HTML 揭露日），不可直接用 cron 觸發當下的日期。
- 既存 snapshot 不可只看 `existing && !force` 就跳寫；應比對 holdings 內容 hash，不同就覆寫（盤後揭露完整版 wins）。
- 排查資料正確性時，**先打 CMoney API 對 ground truth**，不可只看本地 diff 結果就下「無變化」結論。CMoney 端點：
  ```
  https://www.cmoney.tw/MobileService/ashx/GetDtnoData.ashx
    ?action=getdtnodata&DtNo=59449513
    &ParamStr=AssignID={etfCode};MTPeriod=0;DTMode=0;DTRange=5;DTOrder=1;MajorTable=M722;
    &FilterNo=0
  ```
