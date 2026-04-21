/**
 * 高勝率進場 6 位置（書本 Part 12 p.749-754 + Part 2 相關章節）
 *
 * 書本明寫的 6 種做多高勝率位置（用戶 2026-04-21 從書本查證）：
 *   1. 多頭打底趨勢確認 — 均線4線多排、突破MA5、大量、紅K ≥2%（本檔 detectBottomTrendConfirmation）
 *   2. 回後買上漲       — 不破前低、突破MA5、大量、紅K（trendAnalysis.ts pulledBackBuy）
 *   3. 盤整突破         — 突破盤整上頸線、均線4線多排、大量、紅K（trendAnalysis.ts rangeBreakout）
 *   4. 均線糾結突破     — 突破3/4線糾結（一字底）、大量、紅K（本檔 detectMaClusterBreak）
 *   5. 強勢短回續攻     — 強勢股回檔1~2天、紅K大量突破前黑K高點（本檔 detectStrongPullbackResume）
 *   6. 假跌破反彈       — 假跌破真上漲、突破上頸線、大量、紅K（本檔 detectFalseBreakRebound）
 *
 * 本檔實作 1, 4, 5, 6 四個 detector；2-3 繼續留在 trendAnalysis.ts。
 *
 * 閾值來源：
 *   - 攻擊量 ≥ 前日 × 1.3（Part 7 p.488）
 *   - 糾結閾值 3%（書本沒明寫，取 max(MA5,10,20) 相對收盤差 <3%）
 *   - 假跌破窗口 5 天（書本「回檔跌破後很快站回」的「很快」具體化）
 */
import { CandleWithIndicators } from '@/types';
import { detectTrend, findPivots } from './trendAnalysis';

/**
 * 位置①：多頭打底趨勢確認（書本 Part 12 p.749-754 高勝率位置 1）
 * 書本：多頭打底趨勢確認、均線4線多排、收盤突破MA5、大量、實體紅K棒（漲幅大於2%）
 *
 * 與位置②「回後買上漲」的區別：
 *   位置① = 剛從底部結束空頭 / 盤整，近期曾跌破MA20，是多頭的「第一次」確認
 *   位置② = 已在多頭中的短暫回檔，收盤跌破MA5後站回
 */
export function detectBottomTrendConfirmation(
  candles: CandleWithIndicators[],
  index: number,
): boolean {
  if (index < 20) return false;
  const c    = candles[index];
  const prev = candles[index - 1];
  if (!c || !prev) return false;

  // 多頭趨勢（頭頭高底底高）確認
  const trend = detectTrend(candles, index);
  if (trend !== '多頭') return false;

  // 均線4線多排
  if (!c.ma5 || !c.ma10 || !c.ma20 || !c.ma60) return false;
  if (!(c.ma5 > c.ma10 && c.ma10 > c.ma20 && c.ma20 > c.ma60)) return false;

  // 昨日收盤 < MA5（剛從底部回升），今日突破MA5
  if (!prev.ma5 || prev.close >= prev.ma5) return false;
  if (c.close < c.ma5) return false;

  // 實體紅K ≥ 2%
  if (c.close <= c.open) return false;
  const bodyPct = c.open > 0 ? (c.close - c.open) / c.open : 0;
  if (bodyPct < 0.02) return false;

  // 大量 ≥ 前日 × 1.3
  if (prev.volume <= 0 || c.volume < prev.volume * 1.3) return false;

  return true;
}

/**
 * 位置⑤：強勢短回續攻（書本 Part 12 p.749-754 高勝率位置 5）
 * 書本：強勢股回檔1～2天後，出現強勢續攻的實體紅K棒、大量、收盤突破下跌黑K高點
 *
 * 與位置②「回後買上漲」的區別：
 *   位置⑤ = 強勢多頭股僅回檔1~2根黑K，今日突破黑K高點（不需跌破MA5）
 *   位置② = 回檔至收盤 < MA5，今日站回MA5
 */
export function detectStrongPullbackResume(
  candles: CandleWithIndicators[],
  index: number,
): boolean {
  if (index < 3) return false;
  const c    = candles[index];
  const prev = candles[index - 1];
  if (!c || !prev) return false;

  // 強勢股 = 多頭趨勢
  const trend = detectTrend(candles, index);
  if (trend !== '多頭') return false;

  // 今日：實體紅K ≥ 2% + 大量 ≥ 前日 × 1.3
  if (c.close <= c.open) return false;
  const bodyPct = c.open > 0 ? (c.close - c.open) / c.open : 0;
  if (bodyPct < 0.02) return false;
  if (prev.volume <= 0 || c.volume < prev.volume * 1.3) return false;

  // 找過去 1~2 日的「下跌黑K」，取其最高點
  const prev2 = index >= 2 ? candles[index - 2] : null;
  const prev3 = index >= 3 ? candles[index - 3] : null;
  let blackKHigh: number | null = null;

  if (prev.close < prev.open) {
    // 1 日回檔（前一根是黑K）
    blackKHigh = prev.high;
    if (prev2 && prev2.close < prev2.open) {
      // 2 日都是黑K，取較高的 high
      blackKHigh = Math.max(blackKHigh, prev2.high);
      // 若前3根全是黑K → 修正超過 2 天，不是「短回」
      if (prev3 && prev3.close < prev3.open) return false;
    }
  } else if (prev2 && prev2.close < prev2.open) {
    // 2 日前是黑K，昨日小幅回升（仍在回檔範圍）
    blackKHigh = prev2.high;
  } else {
    return false; // 近 2 日沒有黑K = 非短回型態
  }

  // 今日收盤突破黑K高點
  return c.close > blackKHigh;
}

/**
 * 打底第 1 支腳（Part 2 p.42-45 + Part 7 p.513）
 * 書本：空頭下跌到低檔，出現爆大量（5 日均量×2）的黑K或止跌紅K → 搶反彈進貨量
 * 注意：此函式保留供獨立使用，但不再列入高勝率 6 位置 tag（用戶 2026-04-21 確認）
 */
export function detectDoubleBottomLeg1(
  candles: CandleWithIndicators[],
  index: number,
): boolean {
  if (index < 30) return false;
  const c = candles[index];

  // 空頭趨勢中
  const trend = detectTrend(candles, index);
  if (trend !== '空頭') return false;

  // 當日爆大量（5 日均量 × 2，書本 Part 7 p.487 爆大量定義）
  const avgVol5 = c.avgVol5;
  if (!avgVol5 || avgVol5 <= 0) return false;
  if (c.volume < avgVol5 * 2) return false;

  // 止跌訊號：紅K 或 長下影黑K
  const isRedK = c.close > c.open;
  const bodyAbs = Math.abs(c.close - c.open);
  const lowerShadow = Math.min(c.open, c.close) - c.low;
  return isRedK || lowerShadow > bodyAbs;
}

/**
 * 打底第 2 支腳 / 黃金右腳（Part 2 p.45 + Part 7 p.515）
 * 書本：已有第 1 腳 + 反彈遇壓回檔不破第 1 腳低點 + 大量紅K 上漲
 */
export function detectDoubleBottomLeg2(
  candles: CandleWithIndicators[],
  index: number,
): boolean {
  if (index < 30) return false;
  const c = candles[index];

  // 當日紅K 實體 ≥2%
  if (c.close <= c.open) return false;
  const bodyPct = c.open > 0 ? (c.close - c.open) / c.open : 0;
  if (bodyPct < 0.02) return false;

  // 當日攻擊量（≥ 前日 × 1.3）
  const prev = candles[index - 1];
  if (!prev || prev.volume <= 0) return false;
  if (c.volume < prev.volume * 1.3) return false;

  // 過去 30 天內找第 1 腳（爆量低點）
  let leg1Low: number | null = null;
  for (let j = index - 30; j <= index - 5; j++) {
    if (j < 0) continue;
    const past = candles[j];
    if (!past?.avgVol5 || past.avgVol5 <= 0) continue;
    if (past.volume >= past.avgVol5 * 2 && past.low > 0) {
      if (leg1Low === null || past.low < leg1Low) leg1Low = past.low;
    }
  }
  if (leg1Low === null) return false;

  // 當日 low 不破第 1 腳低點（底底高）
  return c.low > leg1Low;
}

/**
 * 均線糾結突破（Part 4 p.299-303）
 * 書本：3 條均線聚合盤整 → 當日大量紅K 突破
 * 糾結閾值：(max(MA5,10,20) - min) / close < 3%（書本沒明寫具體%，此為合理實作）
 */
export function detectMaClusterBreak(
  candles: CandleWithIndicators[],
  index: number,
): boolean {
  const c = candles[index];
  if (c.ma5 == null || c.ma10 == null || c.ma20 == null || c.close <= 0) return false;

  // 當日三線聚合
  const maMax = Math.max(c.ma5, c.ma10, c.ma20);
  const maMin = Math.min(c.ma5, c.ma10, c.ma20);
  if ((maMax - maMin) / c.close >= 0.03) return false;

  // 過去 5 天也聚合（確認是盤整糾結，不是瞬間交叉）
  if (index < 5) return false;
  const prev5 = candles[index - 5];
  if (!prev5?.ma5 || !prev5?.ma10 || !prev5?.ma20 || prev5.close <= 0) return false;
  const prevSpread =
    (Math.max(prev5.ma5, prev5.ma10, prev5.ma20) -
      Math.min(prev5.ma5, prev5.ma10, prev5.ma20)) / prev5.close;
  if (prevSpread >= 0.03) return false;

  // 當日紅K 實體 ≥2%
  if (c.close <= c.open) return false;
  const bodyPct = (c.close - c.open) / c.open;
  if (bodyPct < 0.02) return false;

  // 當日攻擊量（≥ 5 日均量 × 1.3）
  const avgVol5 = c.avgVol5;
  if (!avgVol5 || c.volume < avgVol5 * 1.3) return false;

  // 收盤突破糾結帶上緣
  return c.close > maMax;
}

/**
 * 假跌破真上漲（書本圖表 12-1-7 進場做多型態⑥ + Part 4 葛蘭碧買點③ p.308-309）
 *
 * 書本嚴格版（2026-04-21 用戶授權 C 方案）：
 *   1. 前置結構 = 頭底頭底（至少 2 頭 + 2 底 pivots）→ 上下頸線
 *   2. 過去 5 日內出現一根「黑K + 量 ≥ 1.3× + 收盤跌破該日下頸線」= 假跌破
 *   3. 今日「紅K + 實體 ≥ 2% + 量 ≥ 1.3× + 收盤突破上頸線」= 真上漲
 *
 * 假跌破日算頸線時用該日之前的 pivots（避免 pivot 被假跌破本身污染）
 */
export function detectFalseBreakRebound(
  candles: CandleWithIndicators[],
  index: number,
): boolean {
  if (index < 6) return false;
  const c = candles[index];
  const prev = candles[index - 1];
  if (!c || !prev) return false;

  // 今日真上漲檢查
  const isRedK = c.close > c.open;
  if (!isRedK) return false;
  const bodyPct = c.open > 0 ? Math.abs(c.close - c.open) / c.open : 0;
  if (bodyPct < 0.02) return false;
  const todayVolRatio = prev.volume > 0 ? c.volume / prev.volume : 0;
  if (todayVolRatio < 1.3) return false;

  // 今日上頸線（用截至今日 pivots 的最近兩頭連線）
  const allPivots = findPivots(candles, index, 10);
  const topHighs = allPivots.filter(p => p.type === 'high').slice(0, 2);
  if (topHighs.length < 2) return false;
  const hNew = topHighs[0], hOld = topHighs[1];
  const upperAt = (i: number): number => {
    if (hNew.index === hOld.index) return hOld.price;
    return hOld.price + (hNew.price - hOld.price) * (i - hOld.index) / (hNew.index - hOld.index);
  };
  if (c.close <= upperAt(index)) return false;

  // 過去 5 日找假跌破（黑K + 大量 + 收盤跌破當日下頸線）
  for (let i = Math.max(1, index - 5); i < index; i++) {
    const b = candles[i];
    const bPrev = candles[i - 1];
    if (!b || !bPrev) continue;
    const isBlackK = b.close < b.open;
    if (!isBlackK) continue;
    const bVolRatio = bPrev.volume > 0 ? b.volume / bPrev.volume : 0;
    if (bVolRatio < 1.3) continue;

    // 用 i-1 之前的 pivots 算下頸線，避免假跌破本身污染 pivot
    const pivotsBefore = findPivots(candles, i - 1, 10);
    const lowsBefore = pivotsBefore.filter(p => p.type === 'low').slice(0, 2);
    if (lowsBefore.length < 2) continue;
    const lNew = lowsBefore[0], lOld = lowsBefore[1];
    const lowerAtI = lNew.index === lOld.index
      ? lOld.price
      : lOld.price + (lNew.price - lOld.price) * (i - lOld.index) / (lNew.index - lOld.index);

    if (b.close < lowerAtI) return true;
  }
  return false;
}

/**
 * 高勝率 6 位置總判定（p.749-754）
 * 位置 2-3（pulledBackBuy, rangeBreakout）在 evaluateSixConditions 已算，
 * 本函式負責判 1, 4, 5, 6 四個位置。
 */
export function detectExtraHighWinPositions(
  candles: CandleWithIndicators[],
  index: number,
): {
  bottomTrendConfirm:   boolean;
  maClusterBreak:       boolean;
  strongPullbackResume: boolean;
  falseBreakRebound:    boolean;
} {
  return {
    bottomTrendConfirm:   detectBottomTrendConfirmation(candles, index),
    maClusterBreak:       detectMaClusterBreak(candles, index),
    strongPullbackResume: detectStrongPullbackResume(candles, index),
    falseBreakRebound:    detectFalseBreakRebound(candles, index),
  };
}
