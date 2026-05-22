# Phase 1 Baseline KPI — 對齊書本後第一次回測

**產出**：2026-05-22
**回測期間**：2026-01-01 → 2026-05-12（4.5 個月，TW 81 天 / CN 82 天，事件總數 6042 筆）
**資料來源**：
- [v12-comprehensive-after-rollback-15pct-2026-05-21.md](../../data/backtest-output/v12-comprehensive-after-rollback-15pct-2026-05-21.md)（v12 全期間綜合，13 策略 × 4 排序 × 4 持有天數）
- [per-letter-2026-05-21.md](../../data/backtest-output/per-letter-2026-05-21.md)（字母 d5 回測，cutoff 2026-04-21 之後）

**前提**：HIGH_DEVIATION_PCT 25%→15% (commit 995c3a9) + 淘汰法/KD向下 hard gate 恢復 (commit e44b7fc) 已執行。

---

## 1. Phase 1 KPI 門檻（plan 預設值）

| 指標 | 通過門檻 |
|---|---|
| 勝率 | ≥ 52% |
| 平均單筆收盤報酬 | ≥ 2% |
| ≥5% 命中率 | ≥ 50%（補充指標）|
| 樣本數 | ≥ 30（避免小樣本噪音） |

**未在本輪計算**（缺工具）：Profit factor、Max drawdown、Sharpe ratio — 列入 Phase 2 改進項。

---

## 2. 通過門檻的策略×持有天數×排序組合（GO 名單）

| 策略 | 軌道 | 排序 | 持有 | 樣本 | 勝率 | 收盤均 | maxGain均 | ≥5%命中 | 等級 |
|---|---|---|---:|---:|---:|---:|---:|---:|:--:|
| **打底完成** | 反轉 | 漲幅/六條件/面板對齊 | d5 | 35 | 62.9% | +4.22% | +12.04% | 74.3% | **A** |
| **打底完成** | 反轉 | 成交額排名 | d5 | 35 | 62.9% | +3.41% | +10.87% | 71.4% | **A** |
| **突破上升軌道線** | 多頭 | 成交額排名 | d5 | 70 | 57.1% | +3.21% | +10.90% | 70.0% | **A** |
| **V 形反轉** | 反轉 | 成交額排名 | d10 | 160 | 55.2% | +6.82% | +18.29% | 82.5% | **A** |
| **高檔拉回** | 多頭 | 成交額排名 | d10 | 70 | 56.3% | +6.64% | +18.10% | 73.4% | **A** |
| **突破上升軌道線** | 多頭 | 成交額排名 | d10 | 70 | 56.3% | +5.85% | +17.74% | 81.3% | **A** |
| **過大量黑 K 高** | 多頭 | 成交額排名 | d10 | 59 | 53.7% | +6.05% | +15.76% | 75.9% | B |
| **打底完成** | 反轉 | 成交額排名 | d10 | 35 | 57.1% | +3.52% | +14.67% | 82.9% | **A** |
| **過大量黑 K 高** | 多頭 | 成交額排名 | d20 | 59 | 56.1% | +14.49% | +28.95% | 85.4% | **A** |
| **突破上升軌道線** | 多頭 | 成交額排名 | d20 | 70 | 62.0% | +14.27% | +31.60% | 92.0% | **A** |
| **高檔拉回** | 多頭 | 成交額排名 | d20 | 70 | 55.1% | +11.04% | +29.07% | 83.7% | **A** |
| **V 形反轉** | 反轉 | 成交額排名 | d20 | 160 | 52.2% | +8.67% | +24.95% | 85.8% | B |

**關鍵發現**：
1. **「成交額排名」是最有效的排序**：所有 GO 組合都用成交額排名，其他排序（漲幅/六條件/面板對齊）報酬高但勝率多在 40-50% 之間
2. **「打底完成 d5」是最強短打**：62.9% 勝率 + 4.22% 報酬，A 級
3. **「成交額排名 × d20」幾乎全 A**：突破上升軌道線 / 過大量黑 K 高 / 高檔拉回 都過 50% 勝率 + 10% 以上報酬
4. **持有越久報酬越高但勝率不見得高**：d10/d20 的成交額排名版本兼顧勝率與報酬

---

## 3. 未過門檻的策略（NO-GO 警示名單）

從等級彙整表（依「漲幅」排序、d5）：

| 策略 | 軌道 | d5 收盤 | d5 勝率 | 等級 | 處置 |
|---|---|---:|---:|:--:|---|
| 回後買上漲 | 多頭 | -0.31% | 39.1% | D | 用「成交額排名」可救（見下） |
| 缺口進場 | 多頭 | -1.58% | 34.3% | D | 全持有天數都 D，**強警示** |
| 一字底突破 | 反轉 | -0.53% | 41.9% | D | 全持有天數都 D，**強警示** |
| K 線橫盤突破 | 多頭 | -0.85% | 41.3% | D | 全持有天數都 D，**強警示** |
| 三均線戰法 | 戰法 | -0.28% | 47.1% | D | d20 +7.08%/46% 救得回來 |

**處置**：「強警示」策略在 paper trading（Phase 3）暫停執行，回測再驗 1-2 個月後決定。

---

## 4. 排序效應（同策略不同排序的差異）

從 v12-comprehensive 第 2 節主排行（d5）：

| 策略 | 漲幅排序 | 六條件排序 | 面板對齊排序 | 成交額排名 |
|---|---|---|---|---|
| 打底完成 | +4.22%/63% A | +4.22%/63% A | +4.22%/63% A | +3.41%/63% A |
| 突破上升軌道線 | +1.51%/44% D | +1.78%/47% C | +1.51%/44% D | **+3.21%/57% A** |
| V 形反轉 | +0.80%/46% C | n/a | +0.80%/46% C | **+2.23%/53% B** |
| 高檔拉回 | +0.33%/40% D | +0.81%/54% C | +0.33%/40% D | **+2.19%/53% B** |
| 過大量黑 K 高 | n/a | n/a | n/a | **+1.59%/51% B** |

**結論**：「成交額排名」普遍勝過「漲幅」「六條件」「面板對齊」。原因合理 — 成交額大的標的流動性夠、滑價小、機構參與，本來就比小型起漲股穩。

---

## 5. 月份分布健檢（會不會某個月特別差？）

從 v12-comprehensive 第 7 節（依「漲幅」排序、d5）：

| 月份 | 大盤環境 | 過半策略 d5 勝率 | 觀察 |
|---|---|---|---|
| 2026-01 | 多頭末段 | 大量負報酬 | 1 月選股普遍套牢 — 注意「漲幅」排序在多頭末段反追高 |
| 2026-02 | 修正 | 多數策略 +1~+7% | 修正後反彈段選股表現好 |
| 2026-03 | 弱勢 | 半數負報酬 | 弱勢盤策略普遍受傷 |
| 2026-04 | 反彈 | 多數策略 +2~+10% | 反彈段表現最好 |
| 2026-05 | 震盪 | 混合 | 截至 5-12 樣本少，待補 |

**結論**：策略在**反彈段（02、04 月）**表現最好，**多頭末段追高（01 月）**最差。意味著：
- 大盤趨勢過濾很重要 — 應該在大盤偏空時降低部位（目前系統有 Step 0 大盤趨勢偵測）
- Paper trading 階段需要看「跨大盤週期」是否仍穩

---

## 6. 停損效應（第 5 節）

從 v12-comprehensive 第 5 節（d5）：

| 觀察 | 結論 |
|---|---|
| 「打底完成」無停損 +4.22% > -3% 停損 +1.71% | 停損反而切掉了會反彈的單 → **不要對 A 級策略加緊停損** |
| 「回後買上漲」無停損 -0.31% < -3% 停損 +0.18% < -5% 停損 +1.19% | 弱策略加 -5% 停損可救 |
| 「缺口進場」無停損 -1.58% → -3% 停損 -0.94% → -7% 停損 -1.30% | 停損救不回 → 策略本身有問題 |

**Paper trading 階段預設**：A 級策略無停損（或寬鬆 -7%），D 級策略嚴停 -3% 或不執行。

---

## 7. 字母 d5 baseline（per-letter，1 個月樣本）

從 per-letter-2026-05-21.md（cutoff 2026-04-21 之後）：

| 字母 | 軌道 | 樣本 | 勝率 | d5 均 | 等級 |
|---|---|---:|---:|---:|:--:|
| N | 反轉 | 314 | 56.4% | +3.18% | **A** |
| B | 多頭 | 180 | 54.4% | +2.66% | B |
| Q | 戰法 | 373 | 54.4% | +2.23% | B |
| H | 多頭(標籤) | 67 | 53.7% | +2.35% | tentative |
| G | 多頭(標籤) | 50 | 68.0% | +6.23% | tentative |
| M | 多頭 | 66 | 56.1% | +1.98% | tentative（報酬差一點）|
| E | 多頭 | 86 | 53.5% | +1.52% | tentative（報酬未到）|
| C | 多頭 | 35 | 51.4% | +0.87% | tentative |
| I | 多頭(標籤) | 72 | 50.0% | +0.96% | tentative |
| **F** | **反轉** | **266** | **46.2%** | **+0.74%** | **D — 強警示** |
| **P** | **多頭** | **127** | **49.6%** | **+1.78%** | **D — 強警示** |

**警示**：F（V 形反轉）跟 P（高檔拉回）字母版本不過門檻，但 v12-comprehensive 用「成交額排名」排序的 V 形反轉 d10 卻 A 級。差異原因：
- per-letter 版用「any-letter 命中」算（同檔可歸多字母）
- v12-comprehensive 用「每天每策略 top-1」算（取最強）

→ 排序與 top-N 篩選明顯影響績效。Paper trading 必須鎖定 **成交額排名 top-1 ~ top-3**。

---

## 8. Phase 1 GO/NO-GO 結論

| 軌 | 涵蓋策略 | 是否進 Phase 2 (WalkForward) | 是否進 Phase 3 (Paper) |
|---|---|---|---|
| **多頭軌** | B/C/E/J/K/L/M/P | ✅ 進 | ⚠️ 只跑「突破上升軌道線」「高檔拉回」「過大量黑 K 高」三策略，鎖 d10/d20 + 成交額排名 |
| **反轉軌** | D/F/N/O | ✅ 進 | ⚠️ 只跑「打底完成（O）」「V 形反轉（F）」「型態確認（N）」，鎖成交額排名 |
| **戰法軌** | Q | ✅ 進 | ⚠️ 待 d20 數據再驗，目前 d5 中性 |
| **機械軌** | R（乖離率） | ❓ 本輪無數據 | 暫停 paper（沒書本根據，[project_r_track_kept.md](file:///Users/tc/.claude/projects/-Users-tc-Desktop-rockstock/memory/project_r_track_kept.md) 決議 production 保留但驗證階段暫停） |

**Phase 2 啟動條件**：本份完成 → 進 Phase 2。
**Phase 3 啟動條件**：Phase 2 efficiencyRatio ≥ 0.7 + robustnessScore ≥ 60% → 進 Phase 3，且只跑上表「⚠️ 進」的策略。

---

## 9. Phase 2 WalkForward 樣本外驗證 — **資料不足，無統計意義**

**執行**：[scripts/backtest-walk-forward.ts](../../scripts/backtest-walk-forward.ts) (新檔)

**設定**：train=12 / test=4 / step=4（已盡量縮小，只切出 1-2 個窗）

**結果**：

| 市場 | 可用 session | 窗口數 | robustnessScore | efficiencyRatio | aggregate test 勝率 | maxDD | Sharpe | PF |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| TW | 19 | **1** | 0.0% | 1.653 | 38.6% | -31.9% | 0.23 | 1.75 |
| CN | 21 | **2** | 0.0% | -7.137 | 19.6% | -184.3% | -0.35 | 0.41 |

**結論：本輪 WalkForward 不能下任何判斷**。原因：

1. **可用 daily session 太少**：`scan-{market}-long-daily-{YYYY-MM-DD}.json` 只有 2026-04-22 起，約 22 個交易日，切 1-2 個窗根本沒統計學意義
2. **CN maxDD -184%、PF 0.41**：表示「測試窗某個 session 全部標的同向暴跌」，需查是不是某天 CN 大跌觸發的清倉式虧損 → 對 driver 結果信心不足
3. **策略參數用 DEFAULT_STRATEGY (-5%停損/+15%停利/+5%啟動 3%移動停利)**：跟 v12 真實出場規則不同 → 比較結果不能直接套到實盤

**處置**：
- 不擋住 Phase 3。Phase 3 paper trading 本身就是「持續性的樣本外驗證」（每天累積一份前向資料）
- 補課項目（背景任務）：
  1. 寫 `scripts/backfill-daily-scan-blob.ts`，從 L1 candles 重跑 2024-01-01 ~ 2026-04-21 的 daily Step1 池並寫成 `scan-*-long-daily-*.json` 格式 → 給 walk-forward 補長期資料
  2. 改 walk-forward driver 接 v12 出場規則（runSOPBacktest 路徑），對齊真實系統行為

---

## 10. Phase 3 MVP Paper Trade Simulator — 已可跑

**執行**：[scripts/paper-trade-simulator.ts](../../scripts/paper-trade-simulator.ts) (新檔)

**過濾條件**（依 Phase 1 GO 名單）：
- 六條件分數 ≥ 5
- 命中 A 級策略字母（B/M/N/P/Q/O — 對應「打底完成」「過大量黑 K 高」「型態確認」「高檔拉回」「三均線戰法」「打底完成」）
- 成交額排名 top 50
- 每日進場 3 檔（依成交額排名）
- 持有 10 天 + 移動停利 (3% 回撤，5% 啟動) + 停損 -7%

**首次跑（2026-04-22 ~ 2026-05-22，22 天）**：

| 項目 | 數值 | vs Phase 1 KPI 門檻 |
|---|---:|---|
| Tier 1 訊號數 | 13 | （訊號很稀，22 天才 13 筆）|
| 實際進場 | 12 | （1 筆漲停或無資料）|
| 勝率 | 41.7% | ❌ 未達 ≥52% |
| 平均單筆淨報酬 | +1.94% | ❌ 未達 ≥2.0%（差一點點）|
| 初始資金 | $1,000,000 | |
| 最終資金 | $1,422,142 | |
| 期間總報酬 | **+42.21%** | （B1 等權每日 all-in 模型）|

**進場明細精選**：
- 4/27 群聯 +21.57%（profitClimaxExit）— 高勝率飆股
- 4/28 漢磊 +23.98%（profitClimaxExit）
- 5/6 世芯-KY +10.59%
- 5/5 台玻 -7.44%（stopLoss）— 停損保護生效
- 5/14 世界 -12.75%（stopLoss）— **跳空缺口、停損保護失效**

**重要警示**：
1. **+42% 總報酬主要由前兩筆貢獻**：若 4/27-4/28 沒抓到，績效會大幅縮水 → cherry-picking 嫌疑
2. **勝率僅 41.7%**：低於 Phase 1 門檻，但平均 +1.94% 表示「贏的時候贏很多、輸的時候輸不多」（盈虧比夠）
3. **5/14 世界 -12.75% 超過停損 -7%**：跳空缺口讓停損保護失效，這是實盤會遇到的真實風險
4. **樣本量 12 筆嚴重不足**：統計噪音遠大於訊號，需累積 ≥ 60 筆才有意義

**對「能不能賺錢」的初步結論**：
- ✅ **系統真的能交易**：訊號選股、模擬進場、套停損停利、計算淨值，全鏈路 work
- ⚠️ **能否穩定賺錢仍未定**：22 天樣本不夠下結論。Phase 1 baseline（4.5 個月歷史）顯示 A 級組合過門檻，但 Phase 3 首跑 22 天反而勝率掉到 41.7%
- ❗ **可能原因**：
  1. 5 月台股震盪段不利系統（baseline 顯示 1 月也差，反彈段才好）
  2. 過濾條件太嚴 → 訊號太稀 → 統計噪音放大
  3. Tier 1 過濾不對應 baseline GO 名單（baseline 強的是「成交額排名×d10/d20」組合，但 d10 在這 22 天表現不一定佳）

---

## 11. 參數掃描結果（任務 #6）

**執行**：[scripts/paper-trade-sweep.ts](../../scripts/paper-trade-sweep.ts) — 在 HOLD_DAYS × SIGNALS_PER_DAY × TOP_TURNOVER_RANK 共 27 組 × 2 市場 = 54 組上跑 simulator。
**輸出**：[data/paper-portfolio/sweep-2026-05-21.md](../../data/paper-portfolio/sweep-2026-05-21.md)

### TW 過 KPI 6 組（勝率 ≥52% + 平均報酬 ≥2%）

| hold | signals/day | top | 進場 | 勝率 | 平均單筆 | 總報酬 |
|---:|---:|---:|---:|---:|---:|---:|
| **5** | **1** | **50** | 9 | **77.8%** | **+4.54%** | **+43.63%** ← 最強 |
| 10 | 1 | 50 | 9 | 55.6% | +4.60% | +42.25% |
| 20 | 1 | 50 | 9 | 55.6% | +4.60% | +42.25% |
| 5 | 3 | 30 | 7 | 57.1% | +2.28% | +25.82% |
| 5 | 5 | 30 | 7 | 57.1% | +2.28% | +25.82% |
| 5 | 1 | 30 | 6 | 66.7% | +4.13% | +23.07% |

### CN 全軍覆沒（27 組全部 ❌）

| 最佳組合 | 進場 | 勝率 | 平均單筆 | 總報酬 |
|---|---:|---:|---:|---:|
| hold=5, signals=3, top=30 | 20 | 25.0% | +0.55% | +14.77%（仍未過 KPI）|

**所有 CN 組合勝率都 < 35%**，且 hold=10/20 勝率掉到 11-17% — **v12 策略在 CN 市場不適用**。

### Pattern 觀察

1. **signals=1（每天挑 1 檔最強）勝率明顯領先**：菁英選股 > 廣撒網
2. **top=50 是甜蜜點**：top=30 訊號太少（6-7 筆樣本噪音大）、top=100 訊號太雜（勝率掉到 43-54%）
3. **hold=5 普遍最強**：跟 baseline 第 8 節「打底完成 d5」A 級一致；hold=10/20 表現相同表示「移動停利+停損早就觸發，再持有沒意義」
4. **TW vs CN 差異巨大**：同樣的 v12 detector 在台股能跑、在 A 股不能 → 可能是 CN 漲跌停 10%/20% 不同、或 K 線型態 detector 沒對 CN 校準

### ⚠️ Selection bias 警示

**這 22 天剛好包含 4/27-4/28 群聯+21%、漢磊+23%、5/6 世芯-KY+10% 三筆飆股**。

從 9 筆樣本中挑「最強」很容易過度擬合：
- 9 筆裡只要錯失 1 筆 +20% 飆股，勝率掉到 66.7%、平均報酬掉 2 個百分點
- 「signals=1, top=50, hold=5」77.8% 勝率不可能持續 — 統計學上 9 筆達 77.8% 的 95% 信賴區間是 [40%, 96%]

**處置**：把 sweep 的 winning combo 列為「Phase 4 候選」，但不代表「最佳設定」。真實 winning 設定需要 ≥ 60 筆累積。

### 建議：TW 系統暫定設定（待長期驗證）

| 參數 | 暫定值 | 依據 |
|---|---|---|
| MARKET | TW only | CN 策略不適用 |
| signals/day | 1（最強菁英） | 勝率最高 |
| top_turnover_rank | 50 | 訊號量與品質平衡 |
| hold_days | 5 | A 級「打底完成 d5」一致 |
| stopLoss | -7%（書本） | baseline 5/14 世界 -12% 顯示跳空仍有風險 |
| trailingStop | 3% 回撤 / 5% 啟動 | baseline 第 6 節顯示 A 級策略無需緊停損 |
| 過濾字母 | B/M/N/P/Q/O（A 級 baseline）| Phase 1 GO 名單 |

---

## 12. 下一步行動（從本份 baseline 衍生的可執行清單）

1. **每日跑 simulator**：把 [scripts/paper-trade-simulator.ts](../../scripts/paper-trade-simulator.ts) 包裝成 cron `/api/cron/paper-portfolio-tick`，每日盤後 15:00 CST 跑一次，累計到 `data/paper-portfolio/equity-curve-{market}.json`
2. **參數掃描**：跑 `HOLD_DAYS=5,10,20 × SIGNALS_PER_DAY=1,3,5 × TOP_RANK=30,50,100`，看哪組過 Phase 1 KPI 門檻
3. **補長期 daily scan blob**（Task #5）：讓 walk-forward 真正能跑
4. **TW + CN 都跑**：CN 在 v12-comprehensive 報告裡幾乎沒貢獻，需查 evaluator 在 CN 上是否正常
5. **大盤過濾**：baseline 第 5 節顯示「多頭末段（1月）」最虧、「反彈段（2/4 月）」最賺 — Step 0 大盤過濾要在 simulator 中啟用，看效果

---

## 12.5 Paper Portfolio Cron 部署 SOP（任務 #7 完成）

**新增檔案**：
- [lib/paper/paperTradeSimulator.ts](../../lib/paper/paperTradeSimulator.ts)：simulate 核心（TW_PROD_CONFIG = sweep winning combo）
- [app/api/cron/paper-portfolio-tick/route.ts](../../app/api/cron/paper-portfolio-tick/route.ts)：每日 cron handler
- [scripts/launchd/plists/com.rockstock.paper-portfolio-tick.plist](../../scripts/launchd/plists/com.rockstock.paper-portfolio-tick.plist)：本地 launchd 排程

**輸出檔**：
- `data/paper-portfolio/equity-curve-TW.json`：最新累計快照（每次覆蓋）
- `data/paper-portfolio/history/TW-{date}.json`：每日歷史快照（追加）

**首次跑驗證**（2026-05-22 01:53 CST，curl localhost）：
- 22 sessions / 9 picks / 77.8% 勝率 / +4.54% 平均 / +43.63% 總報酬 ✅
- 跟 sweep top-1 組合一致（signals=1/top=50/hold=5）

### 部署方式

**本地 launchd（推薦）**：
```bash
bash scripts/launchd/install-all.sh   # 把所有 com.rockstock.*.plist 重新 bootstrap
launchctl list | grep paper-portfolio  # 確認 paper-portfolio-tick 已 load
tail -f /tmp/rockstock-paper-portfolio-tick.log
```

排程：週一至週五 15:30 CST 自動觸發 `curl localhost:3000/api/cron/paper-portfolio-tick`。
**前提**：dev server 必須在跑（用 `com.rockstock.dev-server.plist` 排程或手動 `npm run dev`）。

**Vercel production**：⚠️ **不能直接 deploy**。Vercel serverless 環境 fs 唯讀（除 `/tmp`），cron route 內 `fs.writeFileSync(data/paper-portfolio/...)` 會 fail。需追加 Vercel Blob 適配（見任務 #9）。本地 launchd 就夠用。

---

## 13. CN 市場 audit（緊急）

掃描顯示 CN 27 組全部 ❌，勝率 11-30%、平均報酬接近 0。**v12 detector 在 CN 不適用**，需獨立 audit。

可能原因：
1. CN 漲跌停幅度不同（主板 10%、創業板/科創板 20%）— 但 BacktestEngine 應該已處理
2. CN K 線型態 detector 沒針對 CN 市場校準（書本以台股為主）
3. CN 政策事件（IPO 凍結資金、年底拉抬等）造成系統性偏差
4. CN forward candles 資料缺漏（candleCache 在 CN 上 hit rate 可能較低）

**建議：暫停 CN paper trading + 實盤**，待單獨 audit 後決定。

---

## 13.4 大盤過濾驗證（任務 #10 完成，含 backfill 全範圍 581 天）

**修補**：[lib/paper/paperTradeSimulator.ts](../../lib/paper/paperTradeSimulator.ts) `getMarketTrendAt()` — 前一日大盤指數（TW: 0050.TW、CN: 000300.SS）需 `close > MA20 且 MA5 > MA10` 才算多頭日。SimConfig `skipNonBullishDays: true` 預設啟用。

**TW 全範圍跑（2024-01-02 ~ 2026-05-22，581 個交易日，含 backfill #5）**：

| 指標 | 22 天樣本（baseline 第 11 節） | 581 天全範圍 | 差異 |
|---|---:|---:|---|
| 大盤過濾 skip 天數 | 0 / 22 | **235 / 581 (40%)** | 大盤過濾真的有作用 |
| 進場筆數 | 9 | **117** | 樣本量 × 13 |
| 勝率 | **77.8%** | **32.5%** | ↓ 45.3 pp |
| 平均單筆 | +4.54% | +0.44% | ↓ 4.10 pp |
| 總報酬 | +43.63% | +31.5% | 年化 ~13% |

### 🚨 重大結論：22 天 77.8% 勝率確認是 selection bias

**baseline 第 11 節已警告「9 筆 77.8% 的 95% 信賴區間是 [40%, 96%]」**。581 天大樣本驗證：真實勝率 32.5%，落在預期下緣。

### 修正版「能不能賺錢」答案

| | 22 天 | 581 天（真值估計） |
|---|---|---|
| 勝率 | 77.8%（假象） | **32.5%** — 不過 Phase 1 KPI 門檻（≥52%） |
| 平均單筆 | +4.54% | **+0.44%** — 不過 Phase 1 KPI 門檻（≥2%） |
| 累計報酬 | +43.63% | **+31.5%** — 年化 ~13% |
| 跟 0050 比 | n/a | 同期 0050 約 +35-45% — **跑輸大盤** |

**目前的 v12 + sweep winning combo + 大盤過濾，年化 ~13%，跑輸 0050 ETF。** 不建議實盤。

### CN 部分（任務 #8 後續驗證）

大盤過濾在 CN 22 天樣本上 **skip 0 / 22 天**（CSI300 一直在多頭區）。意味著：
1. CN 5/13 系統性大跌**是單日突發**，前一日大盤狀態正常 → 大盤過濾擋不住單日突發跌盤
2. CN 21.6% 勝率不是大盤過濾能解決的問題，根因可能真的在 v12 detector 對 A 股 K 線型態不適配
3. 需要更深的 CN audit（建任務 #11）：實際看 v12 detector 命中模式 + 漲跌停影響

### 後續方向（不要急著結論「rockstock 不行」）

1. **不要實盤**：32.5% 勝率 + 0.44% 平均，比存款好但跑輸大盤 ETF
2. **參數空間還沒掃完**：581 天樣本能讓 sweep 真正有意義 → 跑 581 天的 sweep（任務 #12）
3. **大盤過濾還太簡單**：只擋 MA20+MA5/10，沒擋「多日下跌趨勢」「ATR 異常」 → 任務 #13 進階過濾
4. **CN 需要單獨 audit**：先擋 paper trading 跟實盤，等 v12 detector 對 CN 校準後再說

---

## 13.5 CN audit 結論（任務 #8 完成）

**真正根因不是「CN detector 不適用」**，是 `paperTradeSimulator.selectTier1()` 缺大盤趨勢過濾：
- 51 筆 CN 樣本：勝率 21.6%、76.5% 觸發 -7% 停損
- 但最差 10 筆**集中 5 筆同一天（2026-05-13）爆雷**，是大盤系統性大跌
- 最好 10 筆**集中在 4/27-4/28 反彈段**（跟 TW 群聯+漢磊同期）

→ 補救：[任務 #10](#) 加大盤過濾。修完重跑 sweep 對比 before/after，再決定 CN 是否真的不適用。

完整報告：[docs/audit/2026-05-22-cn-paper-trade-audit.md](2026-05-22-cn-paper-trade-audit.md)

---

## 13.6 Phase 4 reconcile 骨架（任務 #4 完成）

**新增**：[scripts/reconcile-live-vs-paper.ts](../../scripts/reconcile-live-vs-paper.ts)

**功能**：每月跑「實盤 vs Paper vs Backtest 三方對帳」，自動算：
- 平均滑價、滑價標準差
- 實盤勝率 vs paper 勝率
- 平均單筆損益差（live - paper）
- Phase 4 KPI 自動判定（勝率比 ≥ 0.8、滑價 ≤ 0.3%、損益差 std ≤ 1%）

**啟動前提**（依賴）：
1. paper trading（任務 #7）跑滿 1 個月、月勝率達 baseline-kpi.md 第 11 節「TW 暫定設定」門檻
2. 用戶開券商帳戶，每筆實盤手動記錄成 `data/live-trades/{date}.json`（schema 見 script 檔頭）

**輸出**：`docs/audit/live-reconcile-{from}-{to}.md` + `data/live-reconcile/monthly-*.json`

---

## 14. 待補項（Phase 2 之前的延伸工作）

1. **計算 Profit factor / Max drawdown / Sharpe**：現有 BacktestEngine 有 `calcBacktestStats` 含這三項，但 v12-comprehensive 沒輸出。下個版本 backtest-v12-comprehensive 加印。
2. **跑更長範圍（17 個月）**：現有 4.5 個月可能在多頭環境偏多 → 補 2024-01 ~ 2025-12 看是否仍穩
3. **TW / CN 拆開看**：現有報告未分市場，無法判斷台股 vs A 股表現差異
4. **手續費敏感度**：報告第 6 節 B1 資金模型已含手續費，但其他章節是「無成本毛報酬」— 標清楚
5. **CN 市場本輪沒有打底完成等優勝者數據**：要查 evaluator 是否對 CN 跑全策略
