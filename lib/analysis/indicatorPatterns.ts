/**
 * 指標 detector — 書本 Part 8 p.538-582
 *
 * 實作：
 *   - MACD 高檔背離 + 7 條 OSC 細則（p.540-547）
 *   - KD 鈍化 ≥80/≤20 + 背離限 20-80（p.553-559）
 *   - RSI 逆勢 >80 超買 / <20 超賣（p.560-565）
 */
import type { CandleWithIndicators } from '@/types';

// ────────────────────────────────────────────────────────────────
// MACD
// ────────────────────────────────────────────────────────────────

export interface MacdOscState {
  redShrinking:   boolean;  // #1 紅柱縮短 → 回檔
  redGrowing:     boolean;  // #2 紅柱漸長 → 漲勢持續
  redDivergence:  boolean;  // #3 紅柱漸長但股價不漲 → 動能背離
  redTurnGrow:    boolean;  // #4 紅柱縮→增 → 回後買上漲
  greenToRed:     boolean;  // #5 綠→紅轉換 → 再漲
  redToGreen:     boolean;  // #6 紅→綠轉換 → 續回檔
  highPeakDiverge: boolean; // #7 高檔背離（股價新高+紅柱未新高）
}

export function detectMacdOsc7(
  candles: CandleWithIndicators[],
  index: number,
): MacdOscState {
  const c = candles[index];
  const prev = candles[index - 1];
  const prev2 = candles[index - 2];
  const osc = c?.macdOSC;
  const oscPrev = prev?.macdOSC;
  const oscPrev2 = prev2?.macdOSC;

  const result: MacdOscState = {
    redShrinking: false, redGrowing: false, redDivergence: false,
    redTurnGrow: false, greenToRed: false, redToGreen: false,
    highPeakDiverge: false,
  };
  if (osc == null || oscPrev == null) return result;

  const isRed = osc > 0;
  const isRedPrev = oscPrev > 0;

  // #1 紅柱縮短
  if (isRed && isRedPrev && osc < oscPrev) result.redShrinking = true;
  // #2 紅柱漸長
  if (isRed && isRedPrev && osc > oscPrev) result.redGrowing = true;
  // #3 紅柱漸長但股價不漲
  if (result.redGrowing && c.close <= prev.close) result.redDivergence = true;
  // #4 紅柱縮→增（至少 3 根比較）
  if (oscPrev2 != null && oscPrev < oscPrev2 && osc > oscPrev && isRed) result.redTurnGrow = true;
  // #5 綠→紅轉換
  if (!isRedPrev && isRed) result.greenToRed = true;
  // #6 紅→綠轉換
  if (isRedPrev && !isRed) result.redToGreen = true;

  // #7 高檔背離：近 20 日兩個高點，股價新高但 osc 未新高
  if (index >= 20) {
    let peak1Idx = -1, peak1Osc = -Infinity, peak1Close = -Infinity;
    let peak2Idx = -1, peak2Osc = -Infinity, peak2Close = -Infinity;
    for (let j = index - 20; j <= index; j++) {
      const k = candles[j];
      if (!k?.macdOSC) continue;
      if (k.close > peak1Close) {
        peak2Idx = peak1Idx; peak2Osc = peak1Osc; peak2Close = peak1Close;
        peak1Idx = j; peak1Osc = k.macdOSC; peak1Close = k.close;
      } else if (k.close > peak2Close) {
        peak2Idx = j; peak2Osc = k.macdOSC; peak2Close = k.close;
      }
    }
    if (peak1Idx > peak2Idx && peak1Close > peak2Close && peak1Osc < peak2Osc) {
      result.highPeakDiverge = true;
    }
  }
  return result;
}

// ────────────────────────────────────────────────────────────────
// KD
// ────────────────────────────────────────────────────────────────

/** KD 高檔鈍化 ≥80（書本 p.553） */
export function isKdHighSaturated(candles: CandleWithIndicators[], index: number): boolean {
  const c = candles[index];
  return c?.kdK != null && c.kdK >= 80 && c?.kdD != null && c.kdD >= 80;
}

/** KD 低檔鈍化 ≤20（書本 p.553） */
export function isKdLowSaturated(candles: CandleWithIndicators[], index: number): boolean {
  const c = candles[index];
  return c?.kdK != null && c.kdK <= 20 && c?.kdD != null && c.kdD <= 20;
}

/** KD 峰背離（20-80 區間內，書本 p.558） */
export function detectKdPeakDivergence(
  candles: CandleWithIndicators[],
  index: number,
): boolean {
  if (index < 20) return false;
  const c = candles[index];
  if (!c?.kdK || c.kdK < 20 || c.kdK > 80) return false;  // 書本 p.558：20-80 才有效

  let peak1Idx = -1, peak1K = -Infinity, peak1Close = -Infinity;
  let peak2Idx = -1, peak2K = -Infinity, peak2Close = -Infinity;
  for (let j = index - 20; j <= index; j++) {
    const k = candles[j];
    if (!k?.kdK) continue;
    if (k.close > peak1Close) {
      peak2Idx = peak1Idx; peak2K = peak1K; peak2Close = peak1Close;
      peak1Idx = j; peak1K = k.kdK; peak1Close = k.close;
    } else if (k.close > peak2Close) {
      peak2Idx = j; peak2K = k.kdK; peak2Close = k.close;
    }
  }
  return peak1Idx > peak2Idx && peak1Close > peak2Close && peak1K < peak2K;
}

/** KD 底背離 */
export function detectKdBottomDivergence(
  candles: CandleWithIndicators[],
  index: number,
): boolean {
  if (index < 20) return false;
  const c = candles[index];
  if (!c?.kdK || c.kdK < 20 || c.kdK > 80) return false;

  let bot1Idx = -1, bot1K = Infinity, bot1Close = Infinity;
  let bot2Idx = -1, bot2K = Infinity, bot2Close = Infinity;
  for (let j = index - 20; j <= index; j++) {
    const k = candles[j];
    if (!k?.kdK) continue;
    if (k.close < bot1Close) {
      bot2Idx = bot1Idx; bot2K = bot1K; bot2Close = bot1Close;
      bot1Idx = j; bot1K = k.kdK; bot1Close = k.close;
    } else if (k.close < bot2Close) {
      bot2Idx = j; bot2K = k.kdK; bot2Close = k.close;
    }
  }
  return bot1Idx > bot2Idx && bot1Close < bot2Close && bot1K > bot2K;
}

// ────────────────────────────────────────────────────────────────
// RSI 逆勢指標（書本 p.560-565）
// ────────────────────────────────────────────────────────────────

/** RSI 超買（>80） */
export function isRsiOverbought(candles: CandleWithIndicators[], index: number): boolean {
  const rsi = candles[index]?.rsi14;
  return rsi != null && rsi > 80;
}

/** RSI 超賣（<20） */
export function isRsiOversold(candles: CandleWithIndicators[], index: number): boolean {
  const rsi = candles[index]?.rsi14;
  return rsi != null && rsi < 20;
}
