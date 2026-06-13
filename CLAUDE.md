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

## 規格書整合批次（2026-06-12 A/B 批，新子系統速查）

外部選股規格書經回測證據裁剪後落地（大戶持股不入分=S軌決議、法人看多不加分、
組合加分降徽章、總分100只做顯示層）：

- **處置股/注意股 veto（B1）**：官方名單 TWSE punish/notice + TPEx disposal →
  `lib/datasource/AttentionListProvider.ts` + `lib/market/attentionList.ts` →
  `data/market/TW/attention/`；cron 17:35 CST。蓋章點=`saveScanSession`（L4 寫入咽喉，
  只標 `disposalVeto`/`attentionNotice` 不剔除）；**硬排除單一事實=`applyPanelFilter.isDisposalVetoed`**
  （backtestStore 三個結果落地點 + backtest-run/all 的 `isDisposedOnSync` 鏡像，scan-parity 合約守）。
  處置=分盤交易制度層不可交易（同漲停買不到），不是選股因子、不違鐵則 #5。riskAgent 紅燈已接。
- **judgmentRulesRef（A1）**：chip/fundamental/news question 附判讀規則清單
  （`lib/agents/judgmentRules.ts`，c-XX/f-XX/n-XX，含回測 caveat）— 描述性引用不計分，
  skill 文件已同步。注意：chip/fundamental/news builder 本來就不是 stub（先前盤點誤判）。
- **chip-extras 持久化（B2）**：融資券/借券/當沖全市場官方 bulk →
  `data/chips/TW/{margin,sbl,daytrade}/`（`lib/chips/ChipExtrasStorage.ts`，與 squeeze/dataLoader
  同信封）；cron 21:40 CST `fetch-chip-extras`。TWSE 同 IP 並發會被限流 → route 內 TWSE 串行；
  TWSE/TPEx provider 已全改 `fetchJsonWithCurlFallback`（直連 TLS reset 老問題）。
  上櫃個股當沖無官方端點（v1 缺口）。法人連買天數/占比衍生欄位在 `/api/chip`（B3，`lib/chips/instDerived.ts`）。
- **題材/板塊（A2）**：25 題材單一事實 `lib/themes/themeMap.ts`（代號↔名稱有 theme-map 合約測試守，
  **代號絕不可憑記憶**）；板塊強弱 `lib/themes/sectorRanking.ts` → `data/sectors/TW/{date}.json`
  （cron 17:10 CST）→ `/sectors` 頁 + `/api/themes/ranking`。6 階段分類是顯示 heuristic 非選股。
- **specScore 顯示層（A3）**：`lib/spec-score/`（4 套類型權重，缺值不入分、coverage 揭露）
  pool build 時 enrich 附掛；**不影響 pool 預設排序**（仍 computeFacetScores/POOL_WEIGHTS，
  spec-score-isolation 合約守）；comboBadges 純標示不加分（「不加組合 bonus」決議不變）。
- **海外同業（B4）**：`lib/scanner/peerMap.ts` + `/overseas` 頁，純顯示層兼記憶體報價 proxy。
- **稀釋公告（B5 修 bug）**：MopsDilutionScraper 換 t187ap04_L/mopsfin_t187ap04_O 重大訊息
  （舊 t187ap36_L 是權證清單）；只掃主旨不掃說明（樣板問答誤判）、剝空白防 MOPS 斷行截斷關鍵字。

> 升級規則：任何「顯示層→排序/計分」的升級（題材階段、combo tie-break、4 套權重、海外領先落後）
> 必須先過 `scripts/backtest-unified-leaderboard.ts` 變體驗證（正 alpha 且不跌出現有前 20 策略）。

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
- **嚴格同日過濾**（2026-05-22 加 / 2026-05-23 改用標題日為主）：所有 cron route 接受 `?date=YYYY-MM-DD`。比對的是「節目日期」= `program_date`（標題解析）優先，沒有的退回 `ymdTaipei(published_at)`。必須 === targetDate 才 should_analyze=true，否則 `skip_reason='wrong_date'`。**為什麼用標題日不是 published_at**：晚間節目常常在隔天 00:xx 才 upload 完，published_at 會掉到隔天，但標題仍寫前一天 — 標題才是真實節目日。videos/{date}.json 也按同一個 program_date 規則分檔。不帶 `?date=` → fallback 72h 窗（向下相容）。Backfill 用法：`?date=2026-05-21&force=1`
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

### 關鍵幀畫面理解（2026-06-12 加）

節目 PPT 上的股票清單/目標價老師常不唸出來，純語音會漏 — 低成本畫面理解管線：

- **流程**：yt-dlp 下載 ≤720p 純視訊流到 temp → ffmpeg 場景偵測抽幀（`select=gt(scene,0.30)`，
  min-gap 4s、120s 保底、上限 400 幀）→ **即刪影片** → python dHash 去重 + macOS Vision OCR
  （pyobjc，zh-Hant，關 languageCorrection）→ TS 初篩（`lib/youtube/keyframeScreen.ts`，
  代號需過 stock-master、1900-2099 年份歧義需 ±6 字內股名佐證）→ WebP q80 永久保留
- **來源開關**：`sources.json` 的 `keyframe_enabled: true`（data-driven 免 rebuild）。
  2026-06-12 先開 4 個簡報重來源驗證 → 同日使用者決議**全面開啟（全部 17 active 來源）**；
  實測 49min 影片全程 ~3 分鐘（下載 52s + 抽幀 90s + OCR 29s），全來源日量 ~5-10GB 下載
- **儲存**：metadata `data/youtube/keyframes/{date}/{video_id}.json` + `keyframe-index.json`
  （dual-storage、每支處理完立即寫）；webp 只存「有代號/股名命中」的幀（FS-only 永久）；
  raw jpg `keyframes-raw/` 10 天清（cleanup-old-data.ts）；`recommendations/` 與 `keyframes/`
  刻意**不進** 30 天清理（事件要活過 D+60、截圖是 mention 永久證據）
- **payload 預算**（防 23:55 nightly 超時）：每影片 ≤30 幀 OCR 文字（400 字截）進 question.json；
  top-5/影片 + 全日 40 幀附 `image_path` 給 skill 選擇性 Read（skill 明定整晚 ≤15 次）；
  每幀帶 `transcript_window`（±45s cue 文字）讓 skill 合併 speech+slide
- **mention 新欄**（全 optional 向下相容）：`source_type`（speech/slide/speech+slide）、
  `mention_time`、`screenshot_ref`、`recommendation_type`（7 值）、`mentioned_price/target_price/stop_loss`
- **cron**：`/api/cron/youtube-keyframes?date&source_id&video_id&force`（sticky skip + 40min 預算）；
  launchd com.rockstock.youtube-keyframes 每小時 :40（scan :00 → transcript :20 → keyframes :40）；
  nightly script step 2.5 補抽錢線下集
- **OCR 代號比 Whisper 同音可靠**：transcript 與 keyframe 對代號矛盾時以 keyframe 為準（skill 規則）
- **slide-only 提取不靠 LLM 自律**：skill Step 9.4 強制跑 `scripts/audit-keyframe-coverage.ts {date}` —
  「±10 字內有股名 或（代號）括號格式」的代號不在 analysis → FAIL exit 1，skill 必須補 mention
  才能完工；裸代號（盤面數字 OCR 殘渣如「震1457點」「收盤 1710 +13.4%」）只 WARN。
  `screenFrame` 另有價格/點數上下文剔除（點/元/年/萬/億後綴、±x.x% 相鄰）防 hit_codes 污染

### 老師推薦績效追蹤（2026-06-12 加）

「誰講的準」— 每筆提及 → 隔日開盤進場 → D+1/3/5/10/20/60 前瞻報酬 → 老師/節目排行榜：

- **事件抽取**（`lib/youtube/recoEvents.ts`，pure）：analysis → RecoEvent，key=`(date,teacher,stock)`，
  同日跨影片合併保留最強型態、多空衝突標 `conflict` 排除統計、每位老師各記一筆；
  舊分析無 `recommendation_type` 用 sentiment fallback（bullish→看多、watchlist→觀察、
  risk_warning→小心追高、bearish→偏空、其餘→只介紹）
- **cohort**：明確買進/看多→scored（主勝率）、觀察/等回檔→watch、偏空→bearish（win=跌）、
  小心追高/只介紹→excluded；門檻沿用 combined_confidence ≥ 0.6
- **基準價**（`recoBaseline.ts`）：提及日次一交易日**開盤**，結算一次凍結進
  `data/youtube/recommendations/{date}.json`；一字鎖死→no_fill 不計分、停牌跳根、
  隔夜 >25% 污染→no_data；**報酬不持久化**，讀取時從 L1 即時算（`recoPerformance.ts`，
  d1=進場日自身收盤、MFE/MAE 60 根、vs ^TWII 超額按日曆日對齊）
- **cron**：`/api/cron/youtube-reco-events?date&force` — sweep 近 3 天抽取 + 結算所有 pending；
  launchd com.rockstock.youtube-reco-settle 15:30 CST 平日（eod-settle-tw 14:30 封 L1 後）；
  nightly script step 5 在分析落地後立即抽
- **UI**：`/youtube/teachers` 獨立頁（30/60/90 天視窗、列展開逐筆事件 drill-down）；
  `/health?tab=youtube` 有入口連結；API `/api/youtube/teacher-leaderboard?days=`、`/api/youtube/teacher-events?teacher=`
- **時光機 walk-forward 驗證（2026-06-13）**：防前視偏誤的跟單回測 — 站在 as-of 當天「只用該天前資料」
  選最準 top-K 老師，跟他們之後的新推薦買到今天，對照「全買」+ 大盤。
  - 科學性關鍵：`computeEventReturns(…, { visibleUntil: asOf })` 把報酬封頂在 asOf，
    碰不到之後的 K 棒（測試 youtube-reco-events「visibleUntil 防前視」守）；站在 T 時 D20 全 null = 沒偷看未來
  - API：`/api/youtube/teacher-leaderboard?asOf=` (as-of 排行榜)、`/api/youtube/teacher-walkforward?asOf=&topK=&selectBy=d1|d5|d20`
  - UI：`/youtube/teachers` 右上「🕰 時光機驗證」toggle；`TimeMachinePanel` 三欄對照 + 自動結論；
    **跟單樣本 <5 筆只警告不下結論**（曇花一現的老師之後沒推薦 → 跟單筆數太少會誤導）
  - 現實限制：資料 2026-05-18 起，目前只能驗 D5 短線；結論對 as-of 日期敏感（單邊行情會偏）
  - 報酬/baseline 單一事實已上移 `lib/backtest/eventReturns.ts`+`eventBaseline.ts`（陸股回測共用，
    `lib/youtube/recoPerformance.ts`+`recoBaseline.ts` 為 thin re-export）；`RecoReturns` 加 `holdReturn`/`holdExcess`（持有至今）
- **回填**：`npx tsx scripts/backfill-youtube-recommendations.ts [--dry-run]`（2026-05-18 起 23 天已回填，
  2,686 事件）；頻道名 fallback 老師（`節目:xxx`）不進老師表、只進節目 rollup；
  CN 股 master 對不到自然排除（v1 TW only）
- **四項延伸（2026-06-13，補完原始需求）**：
  - **最雷一檔 + 共識地雷股**：`recoLeaderboard.extremePick(dir)` 出 best/worst；leaderboard API
    回 `worstStocks`（≥2 老師同推、持有至今平均最差）。UI「最佳▲/最雷▼」欄 + 共識地雷股區塊。
  - **目標價/停損追蹤**：mention 的 `target_price`/`stop_loss`（簡報 OCR）透傳進 RecoEvent；
    `eventReturns.evalTargetStop` 掃進場後 K 線判達標(high≥target)/破停損(low≤stop)；teacher-events
    API 回 `targetStop`，drill-down「目標/停損」欄。資料稀疏（只簡報明確給價的，~5 天 33 筆 target）。
  - **語音vs畫面對照**：`/api/youtube/video-breakdown?date=` 按 mention `source_type` 拆 speech/slide/both；
    `VideoSourceBreakdown` 元件放 /health?tab=youtube，凸顯「畫面獨家」（06-11 達 69 檔老師沒唸的）。
  - **相對族群報酬**：`themeMap.themesOf/peersOf`（code→題材→同題材成分股）；teacher-events 算
    `sector.excess`=持有至今 − 同題材成分股同期平均；drill-down「vs族群」欄。屬某題材才有值。

## 陸股情緒系統（cn-agents，2026-06-12 P1 上線）

「政策定方向，題材聚人氣，資金決強弱」的陸股 18-agent 規格分期落地；P1 = 大盤情緒
週期 + 漲停結構 + 板塊強弱 + 人氣熱度。**自創因子全部隔離在 `lib/cn-agents/`**
（鏡像 cn-sanse 先例，不進書本選股鏈路、不動既有 provider 路由）。
完整規劃見 plan（北向資金已砍 = 2024 後停發死路；明暗盤砍；游資席位併入龍虎榜子分）。

- **資料路徑** `data/cn-agents/`（dual-storage）：`limitup-pool/{date}.json`（漲停/炸板/
  跌停池 + stats）、`breadth/{date}.json` + `breadth/index.json`（近 120 日寬度+階段）、
  `boards/{date}.json`（~990 行業+概念板塊）、`hotness/{date}.json`（東財人氣榜 top100）、
  `_health/{date}.json`；`_klines-cache/`、`_backfill-meta/` 不進 git
- **情緒週期八階段**（`cycle.ts` 純函式可回測）：冰點/修復/啟動/主升/高潮/分歧/退潮/殺跌
  → 今日策略（打板/半路/低吸/波段/觀望）+ 倉位建議。三層：emotionScore 固定錨點合成 →
  raw predicate（優先序 crash→frozen→climax→…）→ hysteresis（非法轉移要 Δ分≥15 或
  連續 2 日同 raw 才放行）。**PHASE_PARAMS 凍結**，改動必升 `CYCLE_RULES_VERSION`
  （現 v2 = 2026-06-12 用 24 個月分位數校準：crash 加「跌停>漲停」支配條款修掉 39% 誤標、
  launch 晉級率門檻 0.5→0.25）+ golden 合約測試 snapshot 會紅
- **資料源失敗鏈**：EM push2ex（漲停池，**date 參數只保留 ~8 個交易日**）→ curlFetch
  代理 → akshare 橋接；板塊走 push2delay 鏡像（push2 本機常 502）+ host failover；
  **歷史回填走日K 重建**（`backfillPools.ts`：精確停板價 round2、主板 EM/Tencent qfq、
  創業科創 Tencent qfq 快取 5,070 檔；**批量 K 線 Tencent-first** — push2his 對批量轟炸
  整批 TLS reset 連代理都封，Tencent 5,045 檔零失敗）
- **cron**：launchd `com.rockstock.cn-agents-eod` 15:10 + 16:30 CST 平日 →
  `/api/cron/cn-agents-eod?date&force`（漲停池→寬度/階段→板塊→人氣榜 per-step
  try/catch、idempotent）；非主板宇宙股皆從 API 自帶資料來，不擴 L1
- **回填/驗證**：`npx tsx scripts/backfill-cn-breadth.ts --from 2024-06-01 [--em-mainboard]`
  （除息旺季要帶 --em-mainboard 用 qfq 序列，L1 不還權接合會漏 ~18% 除息日漲停）；
  `scripts/backtest-cn-sentiment-phase.ts` 與線上同一個 classifyEmotionCycle（parity）
  驗證階段分佈/run length/2024-09-24 政策底
- **UI**：`/health?tab=cn-agents`（階段 badge + 寬度 8 格 + 30 日情緒分趨勢 + 連板梯隊 +
  行業/概念 top10）；API `/api/cn-agents/breadth?days=`
- **已回填**：2024-06-03 ~ 2026-06-12 共 492 日（v2 分佈：修復 20%/主升 23%/高潮 18%/
  啟動 14%/分歧 13%/殺跌 6.7%）
- **歷史兩市成交額**（2026-06-13 補齊 492/492）：push2his 批量封鎖期改走交易所官方每日概况
  （`scripts/cn_market_turnover.py`：上交所 `stock_sse_deal_daily` 股票成交金額×1e8 +
  深交所 `stock_szse_summary` 股票成交金額；走 sse.com.cn/szse.cn 不受 push2his 封鎖；
  與 push2 ulist f6 口徑一致，2026-06-12 本法 3.22 兆 vs cron 3.21 兆）；
  patch 腳本 `scripts/backfill-cn-turnover.ts`（只補 turnover 不重算情緒階段）。
  ⚠️ 假日表盲區：2025-10-08（國慶連假）isTradingDay 誤判 → backfill manifest 已標註移除

### P2（2026-06-13）：龍虎榜 + 游資席位績效 + 回測底座

- **龍虎榜**：`datasource/emDragonTigerDaily.ts`（`assembleLhbDaily(date,{withDetail})`
  走 EM datacenter `RPT_DAILYBILLBOARD_DETAILSNEW` 全榜 + `RPT_BILLBOARD_DAILYDETAILS{BUY,SELL}`
  席位明細；datacenter host 支援任意歷史日期，與 push2ex 池的 8 日窗不同）→
  `data/cn-agents/lhb/{date}.json`（(code,reason) 複合鍵；榜面自帶 D1/D5/D10 fwd）
- **席位**：`seats.ts`（registry.json 52 條知名游資 seed + `lookupSeat` 規則：
  机构专用→institution、沪/深股通→northbound、含「拉萨」→retail_proxy）；
  `seatStats.ts` 每晚**全量重建**（以 dept_code 為 key，registry 只貼標）→
  `seats/stats.json`（勝率 D5/隔日砸盤率/偏好行業）
- **回測底座**：`settleBaseline`/`computeEventReturns` 提升到 `lib/backtest/event{Baseline,Returns}.ts`
  （youtube 端 thin re-export、import-equality 合約測試防 fork）；一字板 no_fill 守衛對打板場景對口
- **hard_score_v0**：`hardScore.ts` 候選池（漲停∪炸板∪龍虎榜淨買∪主力流入top50∪人氣top50）
  → 5 程式子分（`subScores.ts`）→ `computeCnTotalScore` 缺值重加權（政策/題材/技術 P3 才填）→
  tier A/B/C（A 需 score≥60 且 ≥3 子分非缺）+ v0 mode → `events/{date}.json`；
  C 類也入事件驗證「避開」是否真該避
- **回測迴圈**：`backtest/recoPipeline.ts`（settle 三路 K 線：主板 L1 / 創業科創 _klines-cache /
  北交所 no_data）+ `crossTable.ts`（模式×情緒階段勝率，n<10 灰顯）；報酬不持久化即時 derive
- **cron**：lhb 19:30+21:30、seats-rebuild 20:10、reco 16:40(結算)+22:00(抽取) — 全本地 launchd；
  API `/api/cn-agents/{lhb,leaderboard}`；/health tab 加今日龍虎榜 + 席位績效榜
- **回填**：`npx tsx scripts/backfill-cn-lhb.ts --from --detail-from`（全榜輕量 12mo、明細 6mo 通宵）

### P3（2026-06-13）：政策/題材語意層 + 短線情緒總分 + master_decision

- **新聞源** `cnNewsFeed.ts`：東財 7x24（akshare `stock_info_global_em` 主）+ 新浪 7x24 直連（備），
  程式標 policyCandidate 關鍵詞 → `data/cn-agents/news/{date}.json`（cls.cn 本機卡住已棄）。best-effort 非阻斷
- **操作分類器** `tacticClassifier.ts`（純函式）：打板/半路/低吸/反包/弱轉強/趨勢/波段/補漲/防守/高風險
  10 類，日K特徵（`computeTechFeatures`）+ 情緒階段前置（殺跌/冰點 primary 一律觀望）；弱轉強輸出
  conditional「明日競價高開>2%觸發」
- **檔案橋接**（同 youtube pattern）：`bridge/questionBuilder.ts` 寫 `$TMPDIR/rockstock-cn-agents/{date}-question.json`
  （payload <300KB/硬上限400KB，zt_pool120/lhb60/news標題80/candidates程式預打分top60）→ skill
  `~/.claude/commands/cn-agents-analysis.md`（政策→題材映射、題材聚類階段、個股 theme/position）→
  `data/cn-agents/analysis/{date}.json` → `bridge/validateAnalysis.ts` 守衛（symbol⊆candidates 防自創代號、
  enum/界內，與合約測試 cn-analysis-schema 共用同一份規則）
- **總決策** `compose.ts`：hard_score 程式 5 子分 + skill policy/theme 語意分 → `computeCnTotalScore` 重算
  → tier A/B/C + tacticClassifier 精細 mode → `data/cn-agents/daily/{date}.json`（UI）+ master_decision 事件
  （與 hard_score_v0 並行對照，reco settle/leaderboard 自動涵蓋）。**analysis 缺席→policy/theme 重加權照出**
  （analysisPresent=false，degraded）
- **cron**：prepare 21:30（新聞+question）、compose 22:45 + 次日 07:40 if-missing；
  ⚠️ 政策/題材語意目前需手動跑 `/cn-agents-analysis` skill（headless 自動跑是 follow-up，
  仿 youtube-nightly-analysis.sh keychain pattern；沒跑 compose 走 degraded）
- **UI**：/health?tab=cn-agents 加「今日總決策」（A/B/C 分層 + 主線題材 chip + 最值得操作 + 候選TOP10 +
  避開名單，退市股正確 veto）；API `/api/cn-agents/daily`
### P4（2026-06-13）：headless 自動分析 + 模式×情緒階段交叉勝率表

- **headless 自動分析**：`com.rockstock.cn-agents-analysis` 22:15 CST 跑
  `~/.local/bin/rockstock-cn-agents-nightly-analysis.sh`（prepare→headless claude `/cn-agents-analysis`
  重試→compose）；keychain 訂閱、**絕不設 ANTHROPIC_API_KEY**、bypassPermissions。實測產出
  8 題材/33 語意、compose analysisPresent=true。P3 政策/題材語意層自此全自動
- **交叉勝率表**：`backfill-cn-events.ts` 回填 492 天 hard_score 事件（19136 filled）→
  `crossTable.ts` 模式×情緒階段；**預算快照** `leaderboard.json`（reco cron 結算後 rebuild，
  UI 8ms 讀；`?live=1` 才重算 ~50s）→ `/api/cn-agents/leaderboard` + UI「策略×情緒階段勝率」+
  `scripts/report-cn-crosstable.ts`
- **實證結論**（見記憶 [[cn-agents-crosstable-findings]]）：**打板在主升/分歧/高潮系統性虧**
  （超額 -1.2~-1.7%）、唯修復期正；真賺的是低吸/波段；tier A>B>C 單調但只 A 類正報酬。
  **改 mode/tier 邏輯前必先跑 report-cn-crosstable.ts 複驗**
- **P5+ 規劃**：按交叉表校準 mode→分數映射（打板熱階段降權）+ 股吧輿情爬蟲 + 基本面/估值深化

## 頁面職責定位（重構後）

各頁面職責一句話講清楚，不互相侵蝕；同一檔股票可從多個入口進到對應視角：

| 頁面 | 職責 | 主要入口 |
|---|---|---|
| **`/`** | 即時看盤工作台 — K 線 + 分析面板 + 掃描；`/?load={symbol}` 快速載圖 | 各頁股票連結 |
| **`/watchlist`** | 自選股清單與條件監控 | header nav |
| **`/portfolio`** | 持倉管理（記帳工具，本機 zustand store） | header nav |
| **`/etf`** | ETF 持股追蹤與揭露監控 | header nav |
| **`/youtube`** | 純內容分析 — 跨節目共識 + 提及股票 + 個股時間軸（**不含資料抓取狀態**） | header nav |
| **`/youtube/replay`** | YouTube 視角走圖（左 K 線 + 右節目卡片） | `/youtube` 連結 |
| **`/youtube/trends`** | 跨日 7/14/30 天提及排行 | `/youtube` 連結 |
| **`/agents/pool`** | 多源候選股票池（4 source attribution + §0 隔離 + 高共識 chip） | header nav |
| **`/agents`** | 4-phase 流程展示（分析師 → 風控 → 多空 → 決策） | header nav |
| **`/agents/[symbol]`** | 統一股票詳細頁（走圖 + 4 source / 4 verdict + 多空 + YouTube 提及紀錄） | Pool / agents / 股票連結 |
| **`/health`** | 所有資料源健康總覽（tab：行情 / YouTube / 技術 / Agent / 系統任務） | header nav |

> **註（2026-06-06 校正）**：`/youtube`、`/youtube/replay`、`/youtube/trends`、`/agents`、`/agents/pool`、`/today` 現均為 **client-side redirect → 首頁對應 tab**（Stage 7 合併進首頁右側 panel）；上表描述的是「該 tab 的職責」，URL 保留僅為 bookmark 相容。真正獨立頁：`/agents/[symbol]`、`/youtube/stocks/[code]`、`/diagnose/[market]/[symbol]/[date]` 等。`/cn-sanse`、`/tw-sanse` 已移除（→ 404，無內部連結指向），三色功能整併進首頁 tab + 走圖疊圖。

**走圖元件**：`components/shared/StockChartView.tsx`（layout 容器）統一給首頁、scan、replay、`/agents/[symbol]` 用；各頁餵不同 `sidebarSlot`。`CandleChart` + `IndicatorCharts` 是底層 primitive，**不直接被頁面 import**（除測試外）。

**資料邏輯不可混淆**：UI 整合不代表 source 混合。YouTube 是 YouTube source、跨節目共識是 YouTube 的 boost（`YouTubeSourceAttribution.inHighConsensus`）、技術仍是技術 — §0 隔離由 `VISIBLE_SOURCE_BY_AGENT` + `sliceSourcesForAgent`（[lib/agents/candidates/types.ts](lib/agents/candidates/types.ts)）強制保證。

## 健康監控（0513 ABCDE E）

- **資料健康狀態頁**：`/health`（L1 覆蓋率 / L2 fresh / L4 scan / limit-up consistency 紅綠燈）
- **每日快照 cron**：`/api/cron/daily-health-snapshot`（盤後固化到 `data/health-snapshot/`）
- **Webhook 警示**：紅燈時 POST 到 `HEALTH_ALERT_WEBHOOK_URL`（env 設定即啟用；
  Slack/Discord/ntfy.sh 都吃；payload = `{ text, level, dateKey, markets }`）
- **L1 invariant 每日 audit**：`scripts/audit-l1-invariant.ts` + launchd plist
  09:00 CST 自動跑（>100 violations 自動 alert）

## 測試金字塔

```
~485 unit tests (Jest)       — detector / SOP / store
  ~7 contract tests          — scan-parity / cross-source / youtube-consensus
 16 e2e tests (Playwright)   — chart locked / lockwatch flow / hydration
─────────────────────────────
~500 total, tsc clean, 全綠
```

> 數量會跟隨開發增減；以 `npm test` 與 `npm run test:contracts` 的實際輸出為準。

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
