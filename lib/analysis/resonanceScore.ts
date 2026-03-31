import { CandleWithIndicators } from '@/types';

// ═══════════════════════════════════════════════════════════════
//  指標共振評分模組
//  檢測 6 個維度的指標方向一致性，輸出 0-100 分
// ═══════════════════════════════════════════════════════════════

export interface ResonanceResult {
  /** 共振分數 0-100 */
  score: number;
  /** 共振方向 */
  direction: 'bullish' | 'bearish' | 'mixed';
  /** 各維度的方向判定 (+1=多, -1=空, 0=中性) */
  dimensions: {
    ma: number;
    macd: number;
    rsi: number;
    kd: number;
    bb: number;
    volume: number;
  };
  /** 一致的維度數量 */
  alignedCount: number;
}

/**
 * 計算指標共振分數
 * @param candles - K 線資料（含指標）
 * @param index - 當前 K 棒索引
 * @returns 共振分數結果
 */
export function computeResonanceScore(
  candles: CandleWithIndicators[],
  index: number,
): ResonanceResult {
  const c = candles[index];
  const dimensions = { ma: 0, macd: 0, rsi: 0, kd: 0, bb: 0, volume: 0 };

  // ── 1. MA 方向 ──────────────────────────────────────────────
  if (c.ma5 != null && c.ma10 != null && c.ma20 != null) {
    if (c.ma5 > c.ma10 && c.ma10 > c.ma20) {
      dimensions.ma = 1; // 多頭排列
    } else if (c.ma5 < c.ma10 && c.ma10 < c.ma20) {
      dimensions.ma = -1; // 空頭排列
    }
  }

  // ── 2. MACD 方向 ─────────────────────────────────────────────
  if (c.macdDIF != null && c.macdSignal != null && c.macdOSC != null) {
    let macdScore = 0;
    // DIF 在零軸上方 +1, 下方 -1
    if (c.macdDIF > 0) macdScore++;
    else if (c.macdDIF < 0) macdScore--;
    // DIF > Signal (金叉態) +1, 反之 -1
    if (c.macdDIF > c.macdSignal) macdScore++;
    else if (c.macdDIF < c.macdSignal) macdScore--;
    // OSC 為正且遞增 +1
    if (index > 0) {
      const prevOSC = candles[index - 1].macdOSC;
      if (c.macdOSC > 0 && prevOSC != null && c.macdOSC > prevOSC) macdScore++;
      else if (c.macdOSC < 0 && prevOSC != null && c.macdOSC < prevOSC) macdScore--;
    }
    dimensions.macd = macdScore > 0 ? 1 : macdScore < 0 ? -1 : 0;
  }

  // ── 3. RSI 方向 ──────────────────────────────────────────────
  if (c.rsi14 != null) {
    if (c.rsi14 > 55) dimensions.rsi = 1;
    else if (c.rsi14 < 45) dimensions.rsi = -1;
  }

  // ── 4. KD 方向 ───────────────────────────────────────────────
  if (c.kdK != null && c.kdD != null) {
    let kdScore = 0;
    if (c.kdK > 50) kdScore++;
    else if (c.kdK < 50) kdScore--;
    if (c.kdK > c.kdD) kdScore++;
    else if (c.kdK < c.kdD) kdScore--;
    dimensions.kd = kdScore > 0 ? 1 : kdScore < 0 ? -1 : 0;
  }

  // ── 5. BB 位置 ───────────────────────────────────────────────
  if (c.bbPercentB != null) {
    if (c.bbPercentB > 0.6) dimensions.bb = 1; // 偏上軌
    else if (c.bbPercentB < 0.4) dimensions.bb = -1; // 偏下軌
  }

  // ── 6. 成交量方向 ────────────────────────────────────────────
  if (c.volume != null && c.avgVol20 != null && index > 0) {
    const prev = candles[index - 1];
    const volumeRatio = c.volume / c.avgVol20;
    const priceUp = c.close > (prev?.close ?? c.close);
    if (volumeRatio > 1.2 && priceUp) dimensions.volume = 1; // 放量上漲
    else if (volumeRatio > 1.2 && !priceUp) dimensions.volume = -1; // 放量下跌
  }

  // ── 計算共振分數 ─────────────────────────────────────────────
  const dims = Object.values(dimensions);
  const bullishCount = dims.filter(d => d > 0).length;
  const bearishCount = dims.filter(d => d < 0).length;
  const alignedCount = Math.max(bullishCount, bearishCount);

  let direction: 'bullish' | 'bearish' | 'mixed';
  if (bullishCount >= 4) direction = 'bullish';
  else if (bearishCount >= 4) direction = 'bearish';
  else direction = 'mixed';

  // 分數計算：一致性越高分數越高
  // 6/6 = 100, 5/6 = 83, 4/6 = 67, 3/6 = 50, 2/6 = 33, 1/6 = 17
  const rawScore = (alignedCount / 6) * 100;

  // 加分：如果所有指標方向一致，額外加分
  const bonus = alignedCount === 6 ? 10 : alignedCount === 5 ? 5 : 0;
  const score = Math.min(100, Math.round(rawScore + bonus));

  return { score, direction, dimensions, alignedCount };
}
