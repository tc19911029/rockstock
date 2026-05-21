# HIGH_DEVIATION_PCT 25% 偏離書本 — 回滾決策報告

**主審計**：[2026-05-22-knowledge-contamination-audit.md](./2026-05-22-knowledge-contamination-audit.md) 第五類最高優先級
**書本依據**：p.568「乖離 ≥ 15% 改用 MA5 跟隨」
**現狀**：[bookThresholds.ts:142](../../lib/analysis/bookThresholds.ts#L142) = 0.25（commit 496309e，2026-05-19 用戶放寬）

---

## 1. 影響範圍（5 個 code path 連動）

| # | 檔案：行號 | 用途 | 25% → 影響 |
|---|---|---|---|
| 1 | [bookThresholds.ts:142](../../lib/analysis/bookThresholds.ts#L142) | 常數定義 | 源頭 |
| 2 | [entryProhibitions.ts:115](../../lib/rules/entryProhibitions.ts#L115) | **戒律 3**（量價背離+KD高+乖離） | 三項合一觸發更嚴 → 25% 等於戒律 3 幾乎不會擋 |
| 3 | [entryProhibitions.ts:247](../../lib/rules/entryProhibitions.ts#L247) | **做空戒律 3 鏡像** | 同上 |
| 4 | [v12TakeProfit.ts:94](../../lib/sell/v12TakeProfit.ts#L94) | **Step 5 ② 切 MA5** | 25% 才切 → 高檔追蹤過鬆，回吐風險大 |
| 5 | [v12-signals/route.ts:134](../../app/api/portfolio/v12-signals/route.ts#L134) | B/P 進階紀律 MA5 override | 同上 |

**獨立但相關**（不受 `HIGH_DEVIATION_PCT` 控制）：
- [StrategyConfig.ts:153](../../lib/strategy/StrategyConfig.ts#L153) `BASE_THRESHOLDS.deviationMax = 0.25` — Step 1 入場乖離上限（選股池過濾）
- [StrategyConfig.ts:214](../../lib/strategy/StrategyConfig.ts#L214) `ZHU_PURE_BOOK.deviationMax = 0.25`
- [trendAnalysis.ts:558](../../lib/analysis/trendAnalysis.ts#L558) `devMax` 預設 0.25
- [granvilleRules.ts:324](../../lib/rules/granvilleRules.ts#L324) 葛蘭碧⑧停利 = 0.15（未連動，仍書本值）
- [trendAnalysis.ts:479](../../lib/analysis/trendAnalysis.ts#L479) 遛狗理論 MA5/MA20 > 15%（未連動）

⚠️ **不一致現象**：葛蘭碧⑧ + 遛狗理論還是 15%，但戒律 3 / Step 5 ② / 入場乖離已放寬到 25% — **內部規則互打架**。

---

## 2. 方案評估

| 方案 | 內容 | 優點 | 風險 |
|---|---|---|---|
| **A** | 維持 25% | 不動 | 偏離書本、與內部 15%/25% 規則互打架（葛蘭碧⑧、遛狗都是 15%） |
| **B**（建議） | 全部回滾到 15% | 對齊書本、消除內部不一致 | 選股池會縮、戒律 3 觸發變頻、B/P 切 MA5 提前 → **必須重跑回測** |
| **C** | A 策略嚴格 15%，其他 25% | 理論可行 | 增加 StrategyConfig 分歧、CLAUDE.md 第 10 條「單一事實」更難維護 |

**推薦：方案 B**。理由：用戶 2026-05-19 放寬是「手動實驗」，主審計已標記為「最高優先級偏離」；目前 codebase 內部就不一致（葛⑧/遛狗仍 15%）；CLAUDE.md 第 5 條明寫「選股條件只用書本規則」，方案 A 持續違反。

---

## 3. 回滾 code 改動清單（待裁決後執行）

| 檔案：行號 | 改前 | 改後 |
|---|---|---|
| `lib/analysis/bookThresholds.ts:142` | `= 0.25` | `= 0.15` |
| `lib/analysis/bookThresholds.ts:141`（註解） | 「2026-05-19 用戶放寬到 25%，偏離書本」 | 「書本 p.568：乖離 ≥ 15% 改用 MA5」 |
| `lib/rules/entryProhibitions.ts:114`（註解） | `> 25%（2026-05-19 用戶放寬）` | `> 15%（書本）` |
| `lib/rules/entryProhibitions.ts:246`（註解） | `< -25%（...2026-05-19 放寬）` | `< -15%（書本對稱）` |
| `lib/sell/v12TakeProfit.ts:91`（註解） | `2026-05-19 放寬，原 15%` | `書本 p.568` |
| `lib/strategy/StrategyConfig.ts:39`（註解） | `預設 0.25` | `預設 0.15` |
| `lib/strategy/StrategyConfig.ts:153` | `deviationMax: 0.25` | `deviationMax: 0.15` |
| `lib/strategy/StrategyConfig.ts:214` | `deviationMax: 0.25` | `deviationMax: 0.15` |
| `lib/analysis/trendAnalysis.ts:558` | `?? 0.25` | `?? 0.15` |
| `__tests__/v12-phase19-110-111.test.ts` | `close=130`（30% 觸發） | 還原 `close=120`（20% 觸發） |
| `__tests__/v12-portfolio-signals.test.ts` | 同上 | 同上 |

---

## 4. 回滾後必須重跑的回測

**直接受影響字母**（用 HIGH_DEVIATION_PCT 或 deviationMax 過濾的）：
1. **B、P**（進階紀律切 MA5 字母）— [v12-signals/route.ts:134](../../app/api/portfolio/v12-signals/route.ts#L134) → 跑 `backtest-per-letter.ts -- letter=B,P`
2. **走戒律 3 的所有字母**（B/C/D/E/F/J/K/L/M/N/O/P/Q，凡走 `checkLongProhibitions` 都會受影響）— 跑 `backtest-all.ts`
3. **空頭軌**（D/F/N/O 做空 + 戒律 3 鏡像）— 同上 backtest-all 涵蓋
4. **R 軌**（乖離率機械軌）— 不直接用 HIGH_DEVIATION_PCT，**但若同步把 R 軌停掉，需另議**

**時間範圍**：建議至少 **2024-01-01 ~ 2026-05-21**（近 17 個月，含 2024 Q3 急漲段 + 2025 整年波段，能涵蓋「乖離 15-25% 區段」這個原本被 25% 放行、回滾後會被擋的樣本）。

**比對指標**：
- 選股池檔數變化（每日候選縮多少）
- B/P 切 MA5 提前觸發次數 → 對最終勝率/平均報酬影響
- 戒律 3 觸發次數 → 看是否真的避開了高檔下殺案例

**跑法**：
```bash
NODE_OPTIONS="--max-old-space-size=8192" npx tsx scripts/backtest-all.ts --from=2024-01-01 --to=2026-05-21 --tag=before-rollback
# 改 code 後
NODE_OPTIONS="--max-old-space-size=8192" npx tsx scripts/backtest-all.ts --from=2024-01-01 --to=2026-05-21 --tag=after-rollback-15pct
# diff
npx tsx scripts/diff-backtest-top1-d3.ts before-rollback after-rollback-15pct
```

---

## 5. 待裁決

請選擇：
- ✅ **執行方案 B 全面回滾 15%**（需要 2-3 小時跑回測對比後合併）
- ⏸ **方案 A 維持 25%**（請同時批准內部不一致：葛⑧/遛狗 15%、戒律 3/Step 5② 25%；建議在 [FUNDAMENTAL_REQUIREMENTS.md](../FUNDAMENTAL_REQUIREMENTS.md) 補一行「乖離門檻明確偏離書本，書本 15% → 實作 25%」）
- 🔀 **方案 C 策略分歧**（A=ZHU_PURE_BOOK 15%，BASE_THRESHOLDS 25%）

**作者建議**：方案 B。書本是地基，與其讓內部規則互打架，不如回到書本、用回測驗證；若回測證明 25% 真的較佳，再以「明確 deviation 為自創」名義加回，並更新 FUNDAMENTAL_REQUIREMENTS。
