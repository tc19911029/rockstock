/**
 * v12 Step 5 停利實作（v12 Phase 1.10）
 *
 * 書本依據：
 * - 5 步驟 步驟 5 第 2-4 章（紀律 / 獲利目標 / K 棒訊號）p.295-330
 * - 寶典 Part 12-1「3 階段獲利目標」p.745
 * - 寶典 Part 11-2 短線 20 守則 #5-#8 p.711-712
 *
 * Step 5 三種停利目標：
 * - ①紀律：跟 Step 3+4 同一條規則「賺錢狀態」版（不獨立實作）
 * - ②獲利目標：10% / 乖離 15% / 型態目標價
 * - ③K 棒訊號：寶典 15 種多轉空祕笈圖 + 抓線圖 8 K 線下殺
 *
 * v12 議題：
 * - 議題 B：B/P 達 10% 切換進階紀律（已在 v12Operation.ts 實作）
 * - 議題 Step 5 ②：乖離 15% 切 MA5（不直接停利）
 * - 議題 Step 5 ③ G：K 棒訊號累計獲利 > 0% 才啟用
 * - 議題 88：寶典 #7/#8 急漲後高檔反轉（連 3 紅 + 大量長黑 K + 跌破前 K low）
 */

import type { CandleWithIndicators } from '../../types';

import type { V12Letter } from '../analysis/v12Signals';
import { HIGH_DEVIATION_PCT, PROFIT_TARGET_RULE_PCT, PROFIT_HIGH_TIER_PCT, BOOK_VOL_RATIO_MIN, PROFIT_PARTIAL_TP_PCT, CH9_LONG_BLACK_BODY_PCT } from '../analysis/bookThresholds';

// ── Step 5 ② 獲利目標停利 ───────────────────────────────────────────────

export interface TakeProfitInputs {
  letter: V12Letter;
  entryPrice: number;
  todayClose: number;
  todayMA20?: number | null;
  /** N 訊號用：型態目標價 */
  patternTargetPrice?: number;
  /** 通用「到達壓力」用：最近 confirmed pivot high（2026-05-09 新增）*/
  recentPivotHigh?: number;
}

export interface TakeProfitResult {
  triggered: boolean;
  reason?:
    | 'pattern-target'      // ② 達型態目標價
    | 'reach-resistance'    // ② 到達壓力區（書本特定條件 #1，2026-05-09 新增）
    | 'high-deviation'      // ② 乖離 ≥ 15%（切 MA5，不直接停利；書本 p.568，2026-07-04 回滾書本值）
    | 'high-profit-20'      // ② 賺 >20% 改用 MA5 收尾（課程 CH8-4 操作程序(3)，長線模式也生效）
    | 'profit-target-10'    // ② 達 10% 獲利（切換進階紀律 flag）
    | 'high-vol-black-k';   // ③ 寶典 #7/#8 急漲反轉
  /** 進階紀律是否啟用（B/P MA5 切換）*/
  enhancedDisciplineEnabled?: boolean;
  /** 操作模式建議切換為（Step 4 ③）*/
  modeRecommendation?: 'short-bias-MA5' | 'long-mode' | null;
  detail?: string;
}

/**
 * Step 5 ② 獲利目標停利判定
 *
 * 注意：本函數**不直接出場**（除了型態目標價）。其他兩條件只切換紀律：
 * - 達 10%：啟用 B/P 寶典 #5/#6 進階紀律
 * - 乖離 ≥ 15%：建議切 MA5 跟隨（議題 Step 5 ②）
 */
export function checkTakeProfitTargets(inputs: TakeProfitInputs): TakeProfitResult {
  const { letter, entryPrice, todayClose, todayMA20, patternTargetPrice, recentPivotHigh } = inputs;

  const profitPct = (todayClose - entryPrice) / entryPrice;

  // 型態目標價（N 訊號）→ 直接停利
  if (patternTargetPrice != null && todayClose >= patternTargetPrice) {
    return {
      triggered: true,
      reason: 'pattern-target',
      detail: `達型態目標價 ${patternTargetPrice.toFixed(2)}（停利）`,
    };
  }

  // 到達壓力區（書本 5 步驟步驟 5 第 4 章特定條件 #1「做多到達壓力」）
  // ⚠️ 自創 padding（書本沒明寫「距離 ≤ 2%」）— 0513 ABCDE D 標自創
  // 通用實作：close 達最近 confirmed pivot high 的 ±2% 範圍 → 提示停利
  // 注意：不強制出場（triggered: false），讓使用者判斷是否續抱還是了結
  // 未來考慮改用 ATR-based 距離（更貼近書本「接近壓力」精神）
  if (recentPivotHigh != null && recentPivotHigh > 0) {
    const distancePct = Math.abs(todayClose - recentPivotHigh) / recentPivotHigh;
    if (distancePct <= 0.02 && todayClose >= recentPivotHigh * 0.98) {
      return {
        triggered: false,
        reason: 'reach-resistance',
        detail: `到達壓力區（前波高 ${recentPivotHigh.toFixed(2)}，距 ${(distancePct * 100).toFixed(2)}%）— 考慮停利`,
      };
    }
  }

  // 乖離 ≥ 15% → 切 MA5（不直接停利，議題 Step 5 ②；書本 p.568）
  if (todayMA20 != null && todayMA20 > 0) {
    const deviation = (todayClose - todayMA20) / todayMA20;
    if (deviation >= HIGH_DEVIATION_PCT) {
      return {
        triggered: false,
        reason: 'high-deviation',
        modeRecommendation: 'short-bias-MA5',
        detail: `乖離 ${(deviation * 100).toFixed(2)}% ≥ ${(HIGH_DEVIATION_PCT * 100).toFixed(0)}%，建議切 MA5 跟隨`,
      };
    }
  }

  // 課程 CH8-4 操作程序(3)（2026-07-05 巡邏補接）：「連續上漲波段獲利超過 20% 以上
  // → 收盤跌破 MA5 停利（賺夠了就用最敏感的 MA5 收尾）」。
  // advisory 建議切 MA5（不強制出場）；長線模式（守 MA20）之前完全缺這道大賺回吐保護。
  if (profitPct >= PROFIT_HIGH_TIER_PCT) {
    return {
      triggered: false,
      reason: 'high-profit-20',
      modeRecommendation: 'short-bias-MA5',
      detail: `獲利 ${(profitPct * 100).toFixed(1)}% ≥ 20%，課程 CH8-4：改用 MA5 收尾，收盤跌破 MA5 全部停利`,
    };
  }

  // 達 10% → 啟用 B/P 進階紀律（議題 Step 5 ② / 衝突 α）
  if (profitPct >= PROFIT_TARGET_RULE_PCT) {
    return {
      triggered: false,
      reason: 'profit-target-10',
      enhancedDisciplineEnabled: letter === 'B' || letter === 'P',
      detail: `獲利達 ${(PROFIT_TARGET_RULE_PCT * 100).toFixed(0)}%（${(profitPct * 100).toFixed(2)}%）— ${letter === 'B' || letter === 'P' ? '啟用寶典 #5/#6 進階紀律' : '可考慮升級長線'}`,
    };
  }

  return { triggered: false };
}

// ── Step 5 ③ K 棒訊號（高檔反轉）────────────────────────────────────────

export interface KBarSignalInputs {
  todayCandle: CandleWithIndicators;
  yesterdayCandle: CandleWithIndicators;
  twoDaysAgoCandle?: CandleWithIndicators;
  threeDaysAgoCandle?: CandleWithIndicators;
  /** 持倉中累計獲利（議題 G：> 0% 才啟用 K 棒訊號）*/
  cumulativeProfit: number;
  /** 昨日收盤的累計獲利（課程 CH9-3 次日分支用；缺值時次日分支退用 cumulativeProfit） */
  yesterdayCumulativeProfit?: number;
  /** 是否末升段（議題 13）*/
  isEndPhase?: boolean;
}

export interface KBarSignalResult {
  triggered: boolean;
  signalType?:
    | 'piercing-black'         // 穿心黑 K（寶典 #11 強覆蓋）
    | 'long-upper-shadow'      // 高檔長上影（寶典圖 6）
    | 'three-red-with-shadow'  // 連 3 紅 + 上影（寶典 #7）
    | 'bearish-engulfing'      // 高檔長黑吞噬
    | 'high-vol-black-break'   // 寶典 #8 大量長黑 K 跌破前 K 低
    | 'ch9-blowoff-reversal';  // 課程 CH9-3(二)(三) 爆量反轉（分批停利 advisory）
  detail?: string;
  /**
   * 課程 CH9-3（2026-07-04）分批停利建議（advisory，不是強制出場 → triggered 保持 false）：
   *   'partial-tp-half'  = 訊號日：爆大量長黑吞噬/長上影、未破前日低、獲利 >15% → 先停利 1/2
   *   'exit-remaining'   = 次日：昨日為上述訊號日且今日下跌 → 剩餘全數賣出
   */
  advisory?: 'partial-tp-half' | 'exit-remaining';
  sellFraction?: 0.5 | 1;
}

/**
 * 課程 CH9-3(二)(三)/CH8-3(6) 訊號日幾何+量能判定（純函式，訊號日/次日共用）：
 *   bar 為「高檔爆大量長黑吞噬 prev」「爆大量長上影」或「爆大量長黑（非吞噬）」，
 *   且收盤未跌破 prev 低點。
 * 爆量口徑：avgVol5 ×1.5（與 sellSignals 爆量家族同口徑）；avgVol5 缺值退 prev 量比 ×1.5。
 * 2026-07-05 補 'long-black'：CH8-3(6)「高檔爆量長黑或爆量長上影 → 當日停利1/2、
 * 次日下跌全部停利」的長黑（非吞噬幾何）之前斷鏈。
 */
function isCh9BlowoffReversalBar(
  bar: CandleWithIndicators,
  prev: CandleWithIndicators,
): { kind: 'engulf' | 'upper-shadow' | 'long-black' } | null {
  if (bar.close < prev.low) return null; // 已破前日低 → 走既有整批出場訊號，不屬本分支
  const volRatio = bar.avgVol5 != null && bar.avgVol5 > 0
    ? bar.volume / bar.avgVol5
    : prev.volume > 0 ? bar.volume / prev.volume : 0;
  if (volRatio < 1.5) return null;
  // 長黑吞噬（幾何同 bearish-engulfing 分支）
  if (prev.close > prev.open && bar.close < bar.open && bar.open > prev.close && bar.close < prev.open) {
    return { kind: 'engulf' };
  }
  // 長上影（幾何同 long-upper-shadow 分支：上影 > 50% K 線全長）
  const fullLen = bar.high - bar.low;
  const upperShadow = bar.high - Math.max(bar.open, bar.close);
  if (fullLen > 0 && upperShadow / fullLen > 0.5) {
    return { kind: 'upper-shadow' };
  }
  // 爆量長黑（非吞噬）：實體 ≥2% 收黑（口徑單一事實 bookThresholds）
  if (bar.close < bar.open && bar.open > 0 && (bar.open - bar.close) / bar.open >= CH9_LONG_BLACK_BODY_PCT) {
    return { kind: 'long-black' };
  }
  return null;
}

const CH9_KIND_LABEL: Record<'engulf' | 'upper-shadow' | 'long-black', string> = {
  'engulf': '長黑吞噬',
  'upper-shadow': '長上影',
  'long-black': '爆量長黑',
};

/**
 * Step 5 ③ K 棒訊號偵測
 *
 * 議題 G：累計獲利 > 0% 才啟用（純書本「上漲一段後」）。
 *
 * 階段 1 實作高優先 4 個訊號（其他階段 2 補入）：
 * 1. 穿心黑 K（強覆蓋）— 抓線圖 8 K 線下殺 #5
 * 2. 高檔長上影 — 寶典圖 6
 * 3. 高檔長黑吞噬 — 抓線圖 #1
 * 4. 寶典 #8 急漲後大量長黑跌破前 K 低
 */
export function detectKBarExitSignal(inputs: KBarSignalInputs): KBarSignalResult {
  const { todayCandle, yesterdayCandle, twoDaysAgoCandle, cumulativeProfit, yesterdayCumulativeProfit, isEndPhase } = inputs;

  // 議題 G：累計獲利 > 0% 才啟用
  if (cumulativeProfit <= 0) {
    return { triggered: false };
  }

  // ── 課程 CH9-3(二)(三)（2026-07-04）：爆量反轉分批停利 advisory ──
  // 「爆大量長黑吞噬/長上影沒有跌破前一日低點，但獲利超過 15%，可先停利 1/2，次日下跌全數賣出」
  // 條件比下方通用吞噬/長上影分支更特定（加 爆量 + 未破昨低 + >15%），先判。
  // advisory 非強制出場（triggered:false），跨日免持久化：次日用 yesterday/twoDaysAgo 重算（path-independent）。
  //
  // 訊號日：今日爆量長上影/爆量長黑（非吞噬）、未破昨低、獲利 > 15% → 先停利 1/2
  // 2026-07-05 忠實度修：**吞噬不走 1/2** — 課程口徑「長黑吞噬當天全部停利」（CH8-3 講義
  // ＋CH9-3 口述「主力今天跑光光，你不用再等明天」），讓吞噬 fall through 到下方
  // bearish-engulfing 分支照舊 triggered:true 全出，不再被 advisory 攔截弱化。
  const ch9Today = isCh9BlowoffReversalBar(todayCandle, yesterdayCandle);
  if (ch9Today && ch9Today.kind !== 'engulf' && cumulativeProfit > PROFIT_PARTIAL_TP_PCT) {
    return {
      triggered: false,
      signalType: 'ch9-blowoff-reversal',
      advisory: 'partial-tp-half',
      sellFraction: 0.5,
      detail: `③ 課程 CH9-3/CH8-3(6)：高檔爆大量${CH9_KIND_LABEL[ch9Today.kind]}未破昨低、獲利 ${(cumulativeProfit * 100).toFixed(1)}% > 15% → 先停利 1/2，明日下跌全數賣出`,
    };
  }
  // 次日：昨日為訊號日（重算）且今日下跌 → 剩餘全出（含吞噬：若昨日沒出，今日補全出）
  if (twoDaysAgoCandle) {
    const ch9Yesterday = isCh9BlowoffReversalBar(yesterdayCandle, twoDaysAgoCandle);
    const profitAtSignal = yesterdayCumulativeProfit ?? cumulativeProfit;
    if (ch9Yesterday && profitAtSignal > PROFIT_PARTIAL_TP_PCT && todayCandle.close < yesterdayCandle.close) {
      return {
        triggered: false,
        signalType: 'ch9-blowoff-reversal',
        advisory: 'exit-remaining',
        sellFraction: 1,
        detail: `③ 課程 CH9-3：昨日爆量${CH9_KIND_LABEL[ch9Yesterday.kind]}(獲利>15% 應已停利)，今日下跌（${todayCandle.close.toFixed(2)} < ${yesterdayCandle.close.toFixed(2)}）→ 剩餘全數賣出`,
      };
    }
  }

  // ── 1. 穿心黑 K（強覆蓋）—— 跌破前一日紅 K 的 1/2 位置 ──
  // 條件：今日是黑 K + 跌破昨日紅 K 中點 + 跌破前一日最低
  if (
    yesterdayCandle.close > yesterdayCandle.open &&  // 昨日紅 K
    todayCandle.close < todayCandle.open &&          // 今日黑 K
    todayCandle.close < (yesterdayCandle.open + yesterdayCandle.close) / 2 &&
    todayCandle.close < yesterdayCandle.low
  ) {
    return {
      triggered: true,
      signalType: 'piercing-black',
      detail: '③ 穿心黑 K（強覆蓋）— 跌破昨日紅 K 1/2 + 跌破昨日最低',
    };
  }

  // ── 2. 高檔長上影 ──
  // 條件：今日 K 線上影線比例 > 50% K 線全長 + 末升段或高檔
  const todayHigh = todayCandle.high;
  const todayLow = todayCandle.low;
  const todayBodyTop = Math.max(todayCandle.open, todayCandle.close);
  const upperShadowLen = todayHigh - todayBodyTop;
  const fullLen = todayHigh - todayLow;
  if (
    fullLen > 0 &&
    upperShadowLen / fullLen > 0.5 &&
    isEndPhase
  ) {
    return {
      triggered: true,
      signalType: 'long-upper-shadow',
      detail: `③ 高檔長上影（上影線占 ${((upperShadowLen / fullLen) * 100).toFixed(0)}% K 線全長）`,
    };
  }

  // ── 3. 高檔長黑吞噬（陰包陽）──
  // 條件：今日黑 K 包昨日紅 K（open > 昨 close、close < 昨 open）
  if (
    yesterdayCandle.close > yesterdayCandle.open &&  // 昨日紅 K
    todayCandle.close < todayCandle.open &&          // 今日黑 K
    todayCandle.open > yesterdayCandle.close &&      // 今日 open > 昨日 close（高開）
    todayCandle.close < yesterdayCandle.open         // 今日 close < 昨日 open（吞噬）
  ) {
    return {
      triggered: true,
      signalType: 'bearish-engulfing',
      detail: '③ 高檔長黑吞噬（陰包陽）',
    };
  }

  // ── 4. 連 3 紅 + 上影（寶典 K 棒訊號 #7：連續上漲 3 天以上 + 長上影 → 主力出貨）──
  // 條件：今日 + 過去 2 根都紅 K + 今日上影 ≥ 50% K 線全長
  // 2026-05-09 補實作（之前 signalType 列了但 detector 沒寫）
  if (
    twoDaysAgoCandle &&
    twoDaysAgoCandle.close > twoDaysAgoCandle.open &&    // 2 日前紅 K
    yesterdayCandle.close > yesterdayCandle.open &&       // 昨日紅 K
    todayCandle.close > todayCandle.open &&               // 今日紅 K（連 3 紅）
    fullLen > 0 &&
    upperShadowLen / fullLen >= 0.5                       // 今日上影 ≥ K 線全長 1/2
  ) {
    return {
      triggered: true,
      signalType: 'three-red-with-shadow',
      detail: `③ 連 3 紅 + 上影（寶典 #7 主力出貨警示，上影占 ${((upperShadowLen / fullLen) * 100).toFixed(0)}% K 線全長）`,
    };
  }

  // ── 5. 寶典 #8 急漲後大量長黑跌破前 K 低（≥ 20% 累計獲利）──
  // 0513 ABCDE D：改 import PROFIT_HIGH_TIER_PCT (20%) + BOOK_VOL_RATIO_MIN (1.3) 統一
  if (
    cumulativeProfit >= PROFIT_HIGH_TIER_PCT &&
    todayCandle.close < todayCandle.open &&          // 今日黑 K
    yesterdayCandle.volume > 0 &&
    todayCandle.volume / yesterdayCandle.volume >= BOOK_VOL_RATIO_MIN &&
    todayCandle.close < yesterdayCandle.low           // 跌破前 K 低
  ) {
    return {
      triggered: true,
      signalType: 'high-vol-black-break',
      detail: `③ 寶典 #8：上漲 ${(cumulativeProfit * 100).toFixed(0)}% + 大量長黑跌破前 K 低 → 全出`,
    };
  }

  return { triggered: false };
}
