import { resolveHoldingReferencePrice } from '@/lib/portfolio/holdingReferencePrice';

const candles = [
  { date: '2026-06-05', open: 98, high: 101, low: 97, close: 100, volume: 10 },
  { date: '2026-06-08', open: 101, high: 104, low: 100, close: 103, volume: 12 },
];

describe('resolveHoldingReferencePrice', () => {
  test('keeps positive accounting cost as the strategy reference', () => {
    expect(resolveHoldingReferencePrice({ entryPrice: 90, entryDate: '2026-06-07' }, candles)).toEqual({
      price: 90, source: 'accounting-cost',
    });
  });

  test('preserves zero accounting cost while deriving the next trading-day close', () => {
    expect(resolveHoldingReferencePrice({ entryPrice: 0, entryDate: '2026-06-07' }, [...candles].reverse())).toEqual({
      price: 103, source: 'entry-date-close', date: '2026-06-08',
    });
  });

  test('explicit strategy reference overrides candle derivation for zero-cost holdings', () => {
    expect(resolveHoldingReferencePrice({
      entryPrice: 0,
      entryDate: '2026-06-07',
      ui: { strategyReferencePrice: 99 },
    }, candles)).toEqual({ price: 99, source: 'explicit-reference' });
  });
});
