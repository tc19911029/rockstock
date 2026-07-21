/**
 * 書本門檻單一事實來源（Single Source of Truth）
 *
 * 所有「使用者在 UI 看到的條件門檻」都從這裡讀，detector 內部的硬編常數也以此為對照。
 * 衝突時的優先順序：**書本（寶典 > 抓住飆股 > 5 步驟 > 高勝率）** > detector > Config > UI。
 *
 * 改這檔等於改使用者看到的字面值。改前必先回查書本頁碼。
 *
 * 引用慣例：
 * - 寶典 = 朱家泓《活用技術分析寶典》2024 版
 * - 5 步驟 = 朱家泓《做對 5 個實戰步驟》
 * - 抓住飆股 = 朱家泓《抓住飆股輕鬆賺》
 * - 寶典 Part X / p.YY = 書內章節 / 頁碼
 */

// ── 共用書本門檻 ──────────────────────────────────────────────────────────────

/** 紅 K 實體最低 %（寶典 p.55 ⑤、5 步驟 p.40）— 大量長紅 K 的「長」定義 */
export const BOOK_BODY_PCT_MIN = 2.0;

/** 攻擊量最低倍數 vs 前一日（寶典 p.54 ④）— 大量長紅 K 的「大量」定義 */
export const BOOK_VOL_RATIO_MIN = 1.3;

/** 攻擊量課程口徑（線上課程 1-5 投影片「量增 20% 以上」；2026-07-05 裁決-2 使用者拍板按課程）
 *
 *  ⚠️ 2026-07-20 第七輪覆核更正註解：六條件④ gate **不讀本常數**，
 *  實際讀 StrategyConfig.BASE_THRESHOLDS.volumeRatioMin（數值同為 1.2，屬巧合相同）。
 *  本常數目前唯一消費端 = v12Conditions.ts（課程口徑判定）。
 *  個別 detector 引寶典原文 ×1.3 者維持 BOOK_VOL_RATIO_MIN。
 *
 *  ⚠️ 2026-07-20 第七輪查證更正：CH1-5/p01 原文是「成交量比**前一日**量增 20% 以上」，
 *  不是 5 日均量（舊註解寫錯）。兩者基準相同、只差倍數。
 *  ⚠️ 且「課程 1.2 vs 書本 1.3」這個框架不成立 — CH5-1/p04 投影片與逐字稿（講三次）
 *  同樣是「量增 > 昨日 1.3 倍」。真正的衝突是**課程內部 CH1-5 與 CH5-1 自打架**，
 *  現值 1.2 是 2026-07-05 使用者拍板（1ae6b15）。要改須回測 + 重新裁決，不可當 bug 逕修。 */
export const ATTACK_VOL_RATIO_COURSE = 1.2;

// ── K 棒三級制（朱家泓課程 CH2-4/2-5：小棒 / 中棒 / 最大棒）─────────────────
// 實體比例 fraction，與 ruleUtils.bodyPct 同單位（0.065 = 6.5%）。
// 平行於既有 isLongRed/isMedLong（≥2%）與 isSmallCandle（<1.5%），純新增、先不接 gate。

/** 最大棒實體下限（漲停級長紅，課程「最大棒」≥ 6.5%）*/
export const MAX_CANDLE_BODY_PCT = 0.065;
/** 中棒實體下限（三級制中棒 3.5%–6.5%）*/
export const MEDIUM_CANDLE_BODY_MIN = 0.035;

// ── 主掃宇宙最低股價（朱家泓 5 步驟 CH5-2 特別報價「去除股價 < 5 元」）──────────
// 僅 TW；CN 價階不同，暫不套用。供 lib/scanner/TurnoverRank.ts 主掃宇宙過濾。

/** TW 主掃宇宙最低股價（元）— 排除 < 5 元仙股 */
export const TW_UNIVERSE_MIN_PRICE = 5;

// ── F：V 形反轉（朱家泓《理財達人秀》第 57 集「八個字四個條件」）──────────────────
// 老師四關：急跌(連續下跌深) → 底部爆量 → 止跌訊號(變盤線或紅K) → 過高進場
// 逐字稿校正（2026-07-21）：爆量在「低檔那根」不是突破日；止跌可以是變盤線「或紅K」；
//   跌幅老師強調「20% 以上才值得搶」；突破日只要「紅K過高」不強制帶量。

/** 連跌天數門檻：觀察窗中至少 3 根下跌 */
export const VREVERSAL_MIN_DOWN_DAYS = 3;
/** 連跌段累計跌幅 %（老師：急跌 20% 以上才值得搶反彈）*/
export const VREVERSAL_MIN_DROP_PCT = 20;
/** 底部爆量量比：低檔急跌段某根量 ≥ 前段均量 ×1.5（老師：低檔要看到一支爆大量）*/
export const VREVERSAL_VOL_MULT = 1.5;

// ── D：一字底突破（抓住飆股 25 型態 #9）───────────────────────────────────

/** 底部盤整最低天數 */
export const FLATBOTTOM_MIN_CONSOL_DAYS = 40;
/** 突破日量比 vs 盤整期均量 */
export const FLATBOTTOM_BREAKOUT_VOL_MULT = 2.0;

// ── I / K：K 線橫盤突破（寶典 Part 11-1 位置 3 + Part 12-4 祕笈圖 #5）──────

/** 錨點 K 實體 %（2026-07-05 課程對齊：紅黑不管；實體門檻為 ⚠️自創殘留防噪音）*/
export const KLINE_CONSOL_ANCHOR_BODY_PCT = 3;
/** 橫盤天數區間（2026-07-05 裁決按課程：6-3「連續三天」→ 3；原 4 偏嚴漏掉課程原型）*/
export const KLINE_CONSOL_MIN_DAYS = 3;
export const KLINE_CONSOL_MAX_DAYS = 15;
/** 橫盤狹幅（高低差 / 錨點高 %）*/
export const KLINE_CONSOL_MAX_RANGE_PCT = 5;

// ── H / L：突破大量黑 K（寶典 Part 11-1 位置 8 + Part 12-4 祕笈圖 #9）────────

/** 黑 K 實體最低 %（「大量長黑 K」之「長」門檻）*/
export const BLACKK_MIN_BODY_PCT = 1.5;
/** 黑 K 量比 vs 前日 */
export const BLACKK_MIN_VOL_RATIO = 1.3;
/** 突破時限：黑 K 後 N 日內紅 K 突破 */
export const BLACKK_MAX_DAYS_AFTER = 3;

// ── G / J：ABC 突破（寶典 Part 11-1 位置 6 + Part 12-4 祕笈圖 #16）───────────

export const ABC_MIN_PRIOR_RUN_PCT = 8;
export const ABC_MIN_CORRECTION_DROP_PCT = 3;
export const ABC_MIN_CORRECTION_SPAN_DAYS = 6;

// ── B：回後買上漲（寶典 Part 12-4 祕笈圖 #1）──────────────────────────────

/**
 * B「站回 MA5」回看天數窗（含今日）— 過去 N 根 K 棒任一天 close 由跌破 → 站回 MA5
 * 書本《寶典》Part 12-4：站回 MA5 後不一定當日突破，第 1-2 日內補量突破亦可。
 * 視窗用閉區間：detectPullbackBuy 內部用 BOOK_RECLAIM_LOOKBACK - 1 當 offset。
 */
export const BOOK_RECLAIM_LOOKBACK = 3;

// ── M：突破軌道線（v12 寶典 p.387）──────────────────────────────────────────

/** 真突破緩衝 %（抓飆股 p.338 真突破 ×3%）*/
export const TRUE_BREAKOUT_PCT = 0.03;
/** 兩 pivot low 之間最少間隔天數（避免軌道線太陡）*/
export const CHANNEL_MIN_PIVOT_GAP_DAYS = 5;

// ── 均線糾結/盤整 tightness（書本未量化 — 自創）────────────────────────────
//
// 朱家泓「均線糾結突破」（Part 4 p.299-303）+「狹幅盤整 5-6 天」（Part 4 p.299）
// 書本都只用「狹幅 / 糾結 / 緊密」等模糊詞，沒給具體 %。下列常數為實作合理上界，
// 改動會影響選股鬆緊，但不違反書本本意。
//
// ⚠️ 自創 — 0513 ABCDE D-medium 集中管理。

/** 三線聚合最大 spread (max(MA5,10,20)-min) / close 上限（自創 3%）*/
export const MA_CLUSTER_MAX_SPREAD = 0.03;
/** 區間盤整（C/E 一字底/range breakout）狹幅 tightness 上限（自創 15%）*/
export const CONSOL_MAX_TIGHTNESS = 0.15;
/** C 盤整突破：上頸線不大幅上揚（新高 ≤ 舊高 × ratio，自創 1.05）*/
export const C_NECKLINE_MAX_UPWARD_RATIO = 1.05;
/** D 一字底盤整回看最大天數（自創 120）*/
export const FLATBOTTOM_MAX_LOOKBACK = 120;
/** MA20 乖離警示 %（自創 12%，書本 p.568「盡量避免追高」未量化）*/
export const MA20_WARN_DEVIATION_PCT = 0.12;

// ── N：25 型態確認（抓住飆股）─────────────────────────────────────────────

/** 三重底/三重頂價位容差 % */
export const TRIPLE_PATTERN_TOLERANCE_PCT = 0.05;
/** 雙重底/雙重頂價位容差 % */
export const DOUBLE_PATTERN_TOLERANCE_PCT = 0.05;
/** 楔形收斂比率 */
export const WEDGE_CONVERGENCE_RATIO = 1.2;
/** 真跌破緩衝 %（鏡像 TRUE_BREAKOUT_PCT）*/
export const TRUE_BREAKDOWN_PCT = 0.03;

// ── O：打底完成（高勝率位置 1）─────────────────────────────────────────────

export const BASE_COMPLETION_MIN_DAYS = 10;
export const BASE_COMPLETION_MAX_LOOKBACK = 60;
/** 打底期「大量」門檻 vs 過去 5 日均量（O 打底 ×1.5）*/
export const BASE_HIGH_VOL_RATIO = 1.5;

// ── 底部型態爆量門檻（黃金右腳 / 草叢量，寶典第2篇 多頭打底量價）─────────────
//
// 小修-6：黃金右腳 ×1.8 / 草叢量 ×2 / O 打底 ×1.5（BASE_HIGH_VOL_RATIO）原本散落在
// bottomFormationRules.ts 內裸寫，皆是「底部打底期主力進貨爆量」同源同概念門檻，
// 收斂成具名常數集中管理（純重構、值不變、不接 gate）。書本只說「異常大量 / 出奇大量」
// 未給精確倍數，下列數值沿用原 detector 既有實作值，故為「實作值」非「書本值」。

/** 黃金右腳：第 1 支腳附近爆量門檻 vs 5 日均量（原 1.8 裸寫）*/
export const GOLDEN_FOOT_SPIKE_VOL_RATIO = 1.8;
/** 黃金右腳：今日突破頸線時的帶量門檻 vs 5 日均量（原 1.2 裸寫）*/
export const GOLDEN_FOOT_BREAKOUT_VOL_RATIO = 1.2;
/** 草叢量：盤整低檔異常大量門檻 vs 20 日均量（原 2 裸寫）*/
export const ACCUMULATION_VOL_RATIO = 2.0;

// ── P：高檔淺回（高勝率位置 3「等拉回」）──────────────────────────────────

/** 淺回上限（議題 5「等拉回」≤ N 天）*/
export const PULLBACK_MAX_DAYS = 2;
/** 拉回前需有的最低漲幅 % */
export const PULLBACK_MIN_PRIOR_RUN_PCT = 5;

// ── Q：三均戰法（朱家泓網路課程 MA3/MA10/MA24）────────────────────────────
// Q 沒有量價門檻，純均線結構，無常數需要 export。

// ── 書本短線守則（停損 / 停利）─────────────────────────────────────────────
//
// 朱家泓「短線守則」p.41 + 寶典 Part 2：停損 7%、獲利達 10% 啟用進階紀律。
// 這是書本明確規則，UI 任何停損/停利顯示都應讀這兩個常數。

/** 持倉警示：書本 CH7-3「每天檢視、跌幅 >5% 就列警示股準備賣」（純警示，非強制出場）*/
export const LOSS_WATCH_PCT = 0.05;
/** 停損守則：書本「停損 7%」上限 — 進場價 × (1 - 0.07) */
export const STOP_LOSS_RULE_PCT = 0.07;
/** 停損價係數：1 - STOP_LOSS_RULE_PCT = 0.93（給 UI 直接乘） */
export const STOP_LOSS_PRICE_MULT = 1 - STOP_LOSS_RULE_PCT;
/** 停利守則：書本「達 10% 啟用進階紀律」 */
export const PROFIT_TARGET_RULE_PCT = 0.10;
/** 停利價係數：1 + PROFIT_TARGET_RULE_PCT = 1.10（給 UI 直接乘） */
export const PROFIT_TARGET_PRICE_MULT = 1 + PROFIT_TARGET_RULE_PCT;
/** 高乖離切 MA5：書本 p.568「乖離 ≥ 15% 改用 MA5 跟隨」（2026-05-22 從 25% 回滾到書本值） */
export const HIGH_DEVIATION_PCT = 0.15;
/** 獲利分級：高檔（書本「獲利 ≥ 20% 屬高檔」）*/
export const PROFIT_HIGH_TIER_PCT = 0.20;

// ── 課程 CH9-3 訊號停利 / CH10-1 套牢分級（2026-07-04 線上課程更新）────────────

/**
 * 爆量反轉分批停利門檻（課程 CH9-3 p.154/157）：高檔爆大量長黑吞噬 / 長上影
 * 「沒有跌破前一日低點，但獲利超過 15%，可先停利 1/2，次日下跌全數賣出」。
 * 注意：CH8 筆記口述值 20% 是舊值，CH9 講義明確寫 15%（以講義為準）。
 */
export const PROFIT_PARTIAL_TP_PCT = 0.15;
/**
 * CH9-3/CH8-3(6) 爆量反轉的「長黑」實體門檻（收黑實體 ≥2%，比例值）。
 * 2026-07-05 巡邏：原 0.02 hard-code 在 v12TakeProfit 與 holdingsActionEngine 兩處 → 抽單一事實。
 * 注意與 BLACKK_MIN_BODY_PCT（1.5，百分比值、L 黑K突破買法用）口徑不同、刻意分開。
 */
export const CH9_LONG_BLACK_BODY_PCT = 0.02;
/** 套牢定義（課程 CH10-1）：「當股票賠損超過 10% 而持有時稱為被套牢」 */
export const TRAPPED_PCT = 0.10;
/** 深度套牢分界（課程 CH10-1）：跌幅 10~20% 反彈遇壓認賠；超過 20% 走三條路 */
export const TRAPPED_DEEP_PCT = 0.20;
/** 當日跌幅警示（課程 CH10-1）：「每天檢視手上股票跌幅超過 5% 列為警示股準備賣出」
 *  — 當日跌幅口徑；與 LOSS_WATCH_PCT（帳上虧損口徑）並存，兩套基準都保留。 */
export const DAY_DROP_WATCH_PCT = 0.05;

// ── 六大條件分數色階 / 門檻（純顯示用）────────────────────────────────────

/** 核心 5 條件最低門檻（書本「3 線多排」必過）— SixConditionsPanel 顯示用 */
export const CORE_SCORE_MIN = 3;
/** 六條件分數顯示色階：金（建議進場）*/
export const SCORE_COLOR_GOLD = 5;
/** 六條件分數顯示色階：藍（候選）*/
export const SCORE_COLOR_BLUE = 4;

// ── MTF (multi-timeframe) 分數色階（純顯示用，UI ScanResultsTable）───────────

export const MTF_SCORE_STRONG = 4;  // ≥ 4 強
export const MTF_SCORE_OK     = 3;  // ≥ 3 可

// ── AI 信心分級（純顯示用，store backtestStore）────────────────────────────

export const AI_CONFIDENCE_HIGH   = 80;
export const AI_CONFIDENCE_MEDIUM = 50;

// ── 勝率色階（純顯示用，BacktestSection）──────────────────────────────────

export const WIN_RATE_STRONG = 60;
export const WIN_RATE_MEDIUM = 50;

// ── 綜合評分色階（純顯示用，BacktestSection）──────────────────────────────

export const COMPOSITE_STRONG = 70;
export const COMPOSITE_OK     = 55;

// ── 籌碼分級（純顯示用，BacktestSection / TradeRow）──────────────────────

export const CHIP_SCORE_STRONG = 70;
export const CHIP_SCORE_MEDIUM = 50;
/** 籌碼等級門檻：S/A/B/C/D */
export const CHIP_GRADE_S = 80;
export const CHIP_GRADE_A = 65;
export const CHIP_GRADE_B = 50;
export const CHIP_GRADE_C = 35;

// ── 當沖比門檻（純顯示用，ChipDetailPanel）─────────────────────────────────

export const DAY_TRADE_RATIO_HIGH = 40;
export const DAY_TRADE_RATIO_WARN = 25;

// ── KD 指標超買/超賣（純顯示用，IndicatorCharts）──────────────────────────

export const KD_OVERBOUGHT = 80;
export const KD_OVERSOLD   = 20;

// ── 9:25 集合競價進場門檻（DABAN/打板策略，純顯示用）────────────────────

/** 開盤 ≥ 收盤 × (1 + AUCTION_ENTRY_PREMIUM) 才進場 */
export const AUCTION_ENTRY_PREMIUM = 0.02;

// ── Composite Score 加權公式（features/scan/components/TradeRow）──────────
//
// 用於掃描結果列表的綜合評分（顯示用，不影響選股）。
// 權重總和應 ≈ 1.0；改動會直接影響使用者看到的排名。

export const COMPOSITE_WEIGHTS = {
  sixCon:      0.30,
  surge:       0.20,
  winRate:     0.25,
  position:    0.10,
  volume:      0.10,
  breakout:    0.05,
} as const;
