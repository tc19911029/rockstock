import type { Candle } from '@/types';

export interface HoldingReferencePriceInput {
  entryPrice: number;
  entryDate: string;
  ui?: Record<string, unknown>;
}

export interface HoldingReferencePriceResult {
  price: number | null;
  source: 'accounting-cost' | 'explicit-reference' | 'entry-date-close' | 'unavailable';
  date?: string;
}

/**
 * 帳務成本可合法為 0（配股／贈與），但技術停損仍需要一個正的市場參考價。
 * 優先用使用者明訂值；沒有時取 entryDate 當日或之後第一個交易日收盤。
 */
export function resolveHoldingReferencePrice(
  holding: HoldingReferencePriceInput,
  candles: readonly Candle[],
): HoldingReferencePriceResult {
  if (Number.isFinite(holding.entryPrice) && holding.entryPrice > 0) {
    return { price: holding.entryPrice, source: 'accounting-cost' };
  }

  const explicit = holding.ui?.strategyReferencePrice;
  if (typeof explicit === 'number' && Number.isFinite(explicit) && explicit > 0) {
    return { price: explicit, source: 'explicit-reference' };
  }

  // 不假設呼叫端一定已按日期排序；取「取得日當天或之後最早」的有效收盤。
  const entryOrNext = candles.reduce<Candle | null>((earliest, candle) => {
    if (candle.date < holding.entryDate || !Number.isFinite(candle.close) || candle.close <= 0) return earliest;
    return earliest == null || candle.date < earliest.date ? candle : earliest;
  }, null);
  if (entryOrNext) {
    return { price: entryOrNext.close, source: 'entry-date-close', date: entryOrNext.date };
  }

  return { price: null, source: 'unavailable' };
}
