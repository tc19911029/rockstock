import {
  classifySmartMoneyRotation,
  rotationPointFromYahoo,
} from '@/lib/smartmoney/rotation';
import type { YahooBrokerTrades } from '@/lib/datasource/YahooBrokerScraper';

function trades(overrides: Partial<YahooBrokerTrades> = {}): YahooBrokerTrades {
  return {
    date: '2026-08-27',
    buyerRankList: [
      { rank: 1, name: '買方甲', buyVolK: 400, sellVolK: 50, netVolK: 350 },
      { rank: 2, name: '買方乙', buyVolK: 200, sellVolK: 30, netVolK: 170 },
    ],
    sellerRankList: [
      { rank: 1, name: '賣方甲', buyVolK: 20, sellVolK: 200, netVolK: -180 },
    ],
    totalDifferenceVolK: 400,
    totalOverbuyVolK: 600,
    totalOversellVolK: 200,
    concentration: 0.4,
    ...overrides,
  };
}

describe('smart-money rotation', () => {
  test.each([
    [70, 20, 'leading'],
    [69.99, 20, 'improving'],
    [70, 19.99, 'weakening'],
    [69.99, 19.99, 'lagging'],
  ] as const)('classifies %s / %s as %s', (tradeRatio, diffRatio, expected) => {
    expect(classifySmartMoneyRotation(tradeRatio, diffRatio)).toBe(expected);
  });

  test('uses gross buy/sell rows with the image formulas', () => {
    const point = rotationPointFromYahoo({ code: '9999', name: '測試股', trades: trades() });

    expect(point).not.toBeNull();
    expect(point).toMatchObject({
      largeBuyVolume: 600,
      largeSellVolume: 200,
      totalVolume: 1000,
      largeBuyShare: 60,
      largeSellShare: 20,
      largeTradeRatio: 80,
      largeDiffRatio: 40,
      zone: 'leading',
    });
  });

  test('falls back to L1 volume when Yahoo cannot imply total volume', () => {
    const point = rotationPointFromYahoo({
      code: '9999',
      trades: trades({ totalDifferenceVolK: 0, concentration: 0 }),
      fallbackTotalVolume: 2000,
    });

    expect(point?.largeTradeRatio).toBe(40);
    expect(point?.largeDiffRatio).toBe(20);
    expect(point?.zone).toBe('improving');
  });

  test('returns null when no trustworthy total volume exists', () => {
    expect(rotationPointFromYahoo({
      code: '9999',
      trades: trades({ totalDifferenceVolK: 0, concentration: 0 }),
    })).toBeNull();
  });
});
