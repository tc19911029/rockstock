import { calculateUnrealizedSummary } from '@/lib/portfolio/unrealizedSummary';

describe('目前持倉未實現損益彙總', () => {
  test('只依目前持倉與報價計算含費損益', () => {
    const summary = calculateUnrealizedSummary([
      { symbol: '2330.TW', shares: 10, costPrice: 1000 },
      { symbol: '0050.TW', shares: 100, costPrice: 50 },
    ], symbol => ({ '2330.TW': 1100, '0050.TW': 55 }[symbol]));

    expect(summary.totalCost).toBe(15_000);
    expect(summary.totalValue).toBe(16_500);
    expect(summary.totalPnL).toBeCloseTo(1_405.6125, 6);
    expect(summary.returnPct).toBeCloseTo(9.37075, 6);
    expect(summary.missingPriceCount).toBe(0);
  });

  test('零成本配股保留損益金額，但報酬率不可計算', () => {
    const summary = calculateUnrealizedSummary([
      { symbol: '2330.TW', shares: 9, costPrice: 0 },
    ], () => 2410);

    expect(summary.totalPnL).toBeCloseTo(21_594.02175, 6);
    expect(summary.returnPct).toBeNull();
    expect(summary.hasZeroCostHolding).toBe(true);
  });

  test('缺報價時不以成本冒充市值或完整報酬率', () => {
    const summary = calculateUnrealizedSummary([
      { symbol: '2330.TW', shares: 1, costPrice: 1000 },
    ], () => null);

    expect(summary.totalValue).toBe(0);
    expect(summary.totalPnL).toBe(0);
    expect(summary.returnPct).toBeNull();
    expect(summary.missingPriceCount).toBe(1);
  });
});
