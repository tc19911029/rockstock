import { runSingleBacktest, calcBacktestStats, DEFAULT_STRATEGY } from '../lib/backtest/BacktestEngine';
import { StockScanResult } from '../lib/scanner/types';

// 建立假的掃描結果
function mockScanResult(overrides?: Partial<StockScanResult>): StockScanResult {
  return {
    symbol: '2330.TW',
    name: '台積電',
    market: 'TW',
    price: 100,
    changePercent: 2.5,
    volume: 10000000,
    triggeredRules: [],
    sixConditionsScore: 5,
    sixConditionsBreakdown: {
      trend: true, position: true, kbar: true, ma: true, volume: true, indicator: false,
    },
    trendState: '多頭',
    trendPosition: '主升段',
    scanTime: '2024-01-15T13:30:00.000Z',
    ...overrides,
  };
}

// 建立假的前向 K 線
function mockForwardCandles(count: number, startPrice: number, dailyPct = 0.01) {
  return Array.from({ length: count }, (_, i) => {
    const price = startPrice * (1 + dailyPct * (i + 1));
    return {
      date:  `2024-01-${16 + i}`.padEnd(10, '0').slice(0, 10),
      open:  +(price * 0.995).toFixed(2),
      close: +price.toFixed(2),
      high:  +(price * 1.01).toFixed(2),
      low:   +(price * 0.985).toFixed(2),
    };
  });
}

describe('runSingleBacktest', () => {
  test('正常持有5日出場', () => {
    const result = mockScanResult();
    const candles = mockForwardCandles(10, 100, 0.005);
    const trade = runSingleBacktest(result, candles);

    expect(trade).not.toBeNull();
    expect(trade!.entryPrice).toBe(candles[0].open);
    expect(trade!.holdDays).toBe(5);
    expect(trade!.exitReason).toBe('holdDays');
  });

  test('資料不足時回傳 null', () => {
    const result = mockScanResult();
    const trade = runSingleBacktest(result, []);
    expect(trade).toBeNull();
  });

  test('停損觸發', () => {
    const result = mockScanResult();
    // 第一天就暴跌 -10%
    const candles = [
      { date: '2024-01-16', open: 100, close: 88, high: 101, low: 87 },
      { date: '2024-01-17', open: 88, close: 90, high: 92, low: 87 },
    ];
    const strategy = { ...DEFAULT_STRATEGY, stopLoss: -0.07 };
    const trade = runSingleBacktest(result, candles, strategy);

    expect(trade).not.toBeNull();
    expect(trade!.exitReason).toBe('stopLoss');
    expect(trade!.grossReturn).toBeLessThan(0);
  });

  test('停利觸發', () => {
    const result = mockScanResult();
    // 第一天就上漲 +20%
    const candles = [
      { date: '2024-01-16', open: 100, close: 108, high: 122, low: 99 },
      { date: '2024-01-17', open: 108, close: 110, high: 112, low: 107 },
    ];
    const strategy = { ...DEFAULT_STRATEGY, takeProfit: 0.15, stopLoss: null };
    const trade = runSingleBacktest(result, candles, strategy);

    expect(trade).not.toBeNull();
    expect(trade!.exitReason).toBe('takeProfit');
    expect(trade!.grossReturn).toBeGreaterThan(0);
  });

  test('淨報酬小於毛報酬（成本影響）', () => {
    const result = mockScanResult();
    const candles = mockForwardCandles(5, 100, 0.01);
    const trade = runSingleBacktest(result, candles);

    expect(trade).not.toBeNull();
    expect(trade!.netReturn).toBeLessThan(trade!.grossReturn);
    expect(trade!.totalCost).toBeGreaterThan(0);
  });
});

describe('calcBacktestStats', () => {
  test('空陣列回傳 null', () => {
    expect(calcBacktestStats([])).toBeNull();
  });

  test('統計計算正確', () => {
    const result = mockScanResult();
    const winCandles  = mockForwardCandles(5, 100, 0.01);  // +5%
    const lossCandles = Array.from({ length: 5 }, (_, i) => ({
      date: `2024-02-${1 + i}`.padEnd(10, '0').slice(0, 10),
      open: 100 * (1 - 0.005 * (i + 1)),
      close: 100 * (1 - 0.005 * (i + 1)),
      high: 100 * (1 - 0.004 * (i + 1)),
      low: 100 * (1 - 0.006 * (i + 1)),
    }));

    const t1 = runSingleBacktest(result, winCandles)!;
    const t2 = runSingleBacktest(result, lossCandles)!;

    const stats = calcBacktestStats([t1, t2]);
    expect(stats).not.toBeNull();
    expect(stats!.count).toBe(2);
    expect(stats!.winRate).toBeGreaterThanOrEqual(0);
    expect(stats!.winRate).toBeLessThanOrEqual(100);
  });
});
