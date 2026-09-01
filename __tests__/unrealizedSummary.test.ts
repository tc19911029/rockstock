import { calculateUnrealizedSummary } from '@/lib/portfolio/unrealizedSummary';

describe('目前持倉未實現損益彙總', () => {
  test('只依目前持倉與報價計算含費損益', () => {
    const summary = calculateUnrealizedSummary([
      { symbol: '2330.TW', shares: 10, costPrice: 1000 },
      { symbol: '0050.TW', shares: 100, costPrice: 50 },
    ], symbol => ({ '2330.TW': 1100, '0050.TW': 55 }[symbol]));

    expect(summary.totalCost).toBe(15_040);
    expect(summary.totalValue).toBe(16_500);
    expect(summary.totalPnL).toBe(1_371);
    expect(summary.returnPct).toBeCloseTo(9.115691, 6);
    expect(summary.missingPriceCount).toBe(0);
  });

  test('零成本配股保留損益金額，但報酬率不可計算', () => {
    const summary = calculateUnrealizedSummary([
      { symbol: '2330.TW', shares: 9, costPrice: 0 },
    ], () => 2410);

    expect(summary.totalPnL).toBe(21_595);
    expect(summary.returnPct).toBeNull();
    expect(summary.hasZeroCostHolding).toBe(true);
  });

  test('券商投入成本與整數費稅可逐筆對上妹妹持倉表', () => {
    const prices: Record<string, number> = {
      '1711.TW': 44,
      '2303.TW': 132.5,
      '2330.TW': 2440,
      '3289.TWO': 143,
      '3339.TWO': 47.4,
      '6515.TW': 6910,
      '6531.TW': 958,
    };
    const summary = calculateUnrealizedSummary([
      { symbol: '1711.TW', shares: 1000, costPrice: 48.7, investedCost: 48_769 },
      { symbol: '2303.TW', shares: 300, costPrice: 138.5, investedCost: 41_609 },
      { symbol: '2330.TW', shares: 18, costPrice: 0, investedCost: 0 },
      { symbol: '3289.TWO', shares: 10, costPrice: 170.5, investedCost: 1_725 },
      { symbol: '3339.TWO', shares: 1000, costPrice: 46.8, investedCost: 46_866 },
      { symbol: '6515.TW', shares: 2, costPrice: 9965, investedCost: 19_970 },
      { symbol: '6531.TW', shares: 200, costPrice: 997, investedCost: 199_684 },
    ], symbol => prices[symbol]);

    expect(summary.totalValue).toBe(381_920);
    expect(summary.totalCost).toBe(358_623);
    expect(summary.totalPnL).toBe(21_594);
    expect(summary.returnPct).toBeNull();
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
