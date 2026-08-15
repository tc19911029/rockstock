import type { Candle } from '@/types';

/**
 * 台股／陸股正常單日漲跌幅上限不會接近 35%。最近技術視窗若出現更大的收盤價斷層，
 * 多半是股票分割、面額變更、未還原除權或錯碼資料；在還原前不可拿來算 MA／型態。
 */
export const PRICE_DISCONTINUITY_RATIO = 0.35;

export interface PriceDiscontinuity {
  readonly date: string;
  readonly previousClose: number;
  readonly close: number;
  readonly changeRatio: number;
}

export function findRecentPriceDiscontinuity(
  candles: readonly Pick<Candle, 'date' | 'close'>[],
  lookbackBars = 25,
): PriceDiscontinuity | null {
  const start = Math.max(1, candles.length - Math.max(2, lookbackBars));
  for (let index = start; index < candles.length; index += 1) {
    const previousClose = candles[index - 1]?.close;
    const close = candles[index]?.close;
    if (!(previousClose > 0) || !(close > 0)) continue;
    const changeRatio = close / previousClose - 1;
    if (Math.abs(changeRatio) > PRICE_DISCONTINUITY_RATIO) {
      return { date: candles[index].date, previousClose, close, changeRatio };
    }
  }
  return null;
}

export function hasRecentPriceDiscontinuity(
  candles: readonly Pick<Candle, 'date' | 'close'>[],
  lookbackBars = 25,
): boolean {
  return findRecentPriceDiscontinuity(candles, lookbackBars) !== null;
}

/** 舊 R session 沒保存完整 K 線，只能保守隔離極端 MA20 乖離的歷史污染列。 */
export function isLegacyMechanicalDiscontinuity(result: { ma20Deviation?: number | null }): boolean {
  return Number.isFinite(result.ma20Deviation) && Math.abs(result.ma20Deviation!) > 0.5;
}
