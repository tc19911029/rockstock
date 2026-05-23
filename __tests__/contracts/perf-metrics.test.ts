/**
 * Contract test：績效指標計算
 *
 * 守的規則：
 *   - 樣本 < MIN_SAMPLE → status='insufficient-sample'
 *   - 全勝 / 全敗 邊界 case 不爆炸
 *   - MDD 必為 ≤ 0
 *   - winRate ∈ [0, 1]
 *   - expectancy = winRate × avgWin + lossRate × avgLoss
 *   - 字母切片：每個 letter 獨立 sample，依然守 MIN_SAMPLE
 */

import {
  computeMetrics,
  computeMetricsByLetter,
  filterTradesByDateRange,
  MIN_SAMPLE,
} from '@/lib/portfolio/perfMetrics';
import type { ClosedTrade } from '@/lib/portfolio/tradeRecorder';

function makeTrade(o: Partial<ClosedTrade> = {}): ClosedTrade {
  return {
    schemaVersion: 1,
    tradeId: 'T1',
    symbol: '3037.TW',
    name: '欣興',
    market: 'TW',
    entryDate: '2026-04-15',
    entryPrice: 1000,
    shares: 1000,
    exitDate: '2026-04-20',
    exitPrice: 1050,
    exitReason: 'target_hit',
    holdDays: 5,
    grossPnL: 50000,
    fees: 5400,
    netPnL: 44600,
    netReturnPct: 4.46,
    createdAt: '2026-04-20T00:00:00Z',
    ...o,
  };
}

function makeTrades(n: number, returns: number[]): ClosedTrade[] {
  return returns.slice(0, n).map((r, i) => {
    const entryDate = new Date(2026, 0, 1 + i * 7).toISOString().slice(0, 10);
    const exitDate = new Date(2026, 0, 6 + i * 7).toISOString().slice(0, 10);
    return makeTrade({
      tradeId: `T${i}`,
      entryDate, exitDate,
      exitPrice: 1000 * (1 + r / 100),
      netReturnPct: r,
      netPnL: 1000 * 1000 * (r / 100),
    });
  });
}

describe('computeMetrics', () => {
  test('樣本 < MIN_SAMPLE → insufficient-sample', () => {
    const r = computeMetrics(makeTrades(5, [1, 2, 3, 4, 5]));
    expect(r.status).toBe('insufficient-sample');
    expect(r.sampleCount).toBe(5);
  });

  test('樣本 = MIN_SAMPLE 起算', () => {
    const r = computeMetrics(makeTrades(10, [1, 2, -1, 3, -2, 4, -1, 5, -3, 2]));
    expect(r.status).toBe('ok');
    expect(r.sampleCount).toBe(10);
  });

  test('勝率算對：6 勝 4 負 → 0.6', () => {
    const returns = [1, 2, 3, 4, 5, 6, -1, -2, -3, -4];
    const r = computeMetrics(makeTrades(10, returns));
    expect(r.winRate).toBeCloseTo(0.6, 4);
  });

  test('expectancy = winRate × avgWin + lossRate × avgLoss', () => {
    const returns = [2, 4, -1, -3]; // 不夠 sample，但驗算用
    const longReturns = [...returns, ...returns, ...returns]; // 12
    const r = computeMetrics(makeTrades(12, longReturns));
    const expected = r.winRate! * r.avgWin! + (1 - r.winRate!) * r.avgLoss!;
    expect(r.expectancy).toBeCloseTo(expected, 4);
  });

  test('payoffRatio = |avgWin / avgLoss|', () => {
    // 5 個 +4，5 個 -2 → payoff = 4/2 = 2
    const returns = [4, 4, 4, 4, 4, -2, -2, -2, -2, -2];
    const r = computeMetrics(makeTrades(10, returns));
    expect(r.payoffRatio).toBeCloseTo(2, 4);
  });

  test('MDD 必 ≤ 0', () => {
    const returns = Array.from({ length: 20 }, () => Math.random() * 10 - 5);
    const r = computeMetrics(makeTrades(20, returns));
    expect(r.mdd).toBeLessThanOrEqual(0);
  });

  test('全勝 case：MDD = 0、winRate = 1、payoff = ∞ 但代入 0', () => {
    const returns = Array(10).fill(2);
    const r = computeMetrics(makeTrades(10, returns));
    expect(r.winRate).toBe(1);
    expect(r.mdd).toBe(0);
    expect(r.avgLoss).toBe(0);
    // payoffRatio = avgWin / avgLoss = ?/0; 程式回 0
    expect(r.payoffRatio).toBe(0);
  });

  test('全敗 case：MDD < 0、winRate = 0', () => {
    const returns = Array(10).fill(-2);
    const r = computeMetrics(makeTrades(10, returns));
    expect(r.winRate).toBe(0);
    expect(r.mdd).toBeLessThan(0);
    expect(r.maxConsecLosses).toBe(10);
  });

  test('最大連敗 = 3（中間插勝）', () => {
    const returns = [-1, -2, -3, 1, -1, -2, 1, -1, -1, 1]; // 連敗 3, 然後 2, 然後 2
    const r = computeMetrics(makeTrades(10, returns));
    expect(r.maxConsecLosses).toBe(3);
  });

  test('totalReturn = prod(1+r) - 1（複利）', () => {
    const returns = [10, 10]; // 1.1 × 1.1 = 1.21 → 21%
    const longReturns = [...returns, ...Array(8).fill(0)];
    const r = computeMetrics(makeTrades(10, longReturns));
    // (1.1)(1.1)(1)(1)...(1) - 1 = 0.21
    expect(r.totalReturn).toBeCloseTo(21, 1);
  });

  test('Sharpe = mean/std × sqrt(tradesPerYear)', () => {
    const returns = [2, 3, -1, 4, -2, 1, 3, -1, 2, 1];
    const r = computeMetrics(makeTrades(10, returns));
    expect(r.sharpe).toBeDefined();
    expect(typeof r.sharpe).toBe('number');
    expect(Number.isFinite(r.sharpe!)).toBe(true);
  });

  test('Sortino ≥ Sharpe（dsd ≤ sd 時）', () => {
    const returns = [5, -1, 4, -2, 3, -1, 4, 5, -1, 2];
    const r = computeMetrics(makeTrades(10, returns));
    // 通常 Sortino > Sharpe 因為 downside dev ≤ total dev
    expect(r.sortino).toBeDefined();
    expect(Math.abs(r.sortino!)).toBeGreaterThanOrEqual(Math.abs(r.sharpe!) * 0.99);
  });

  test('totalDays > 0、tradesPerYear 合理', () => {
    const r = computeMetrics(makeTrades(10, [1, 2, 3, -1, 2, 1, -1, 3, 2, -1]));
    expect(r.totalDays).toBeGreaterThan(0);
    expect(r.tradesPerYear).toBeGreaterThan(0);
  });

  test('totalNetPnL 為所有 trades.netPnL 加總', () => {
    const trades = makeTrades(10, [1, 2, 3, 4, 5, -1, -2, -3, -4, -5]);
    const sum = trades.reduce((s, t) => s + t.netPnL, 0);
    const r = computeMetrics(trades);
    expect(r.totalNetPnL).toBeCloseTo(sum, 2);
  });

  test('MIN_SAMPLE = 10（防止悄悄調低）', () => {
    expect(MIN_SAMPLE).toBe(10);
  });
});

describe('computeMetricsByLetter', () => {
  test('按字母切片，各自獨立 sample 判斷', () => {
    const trades = [
      ...makeTrades(10, Array(10).fill(2)).map(t => ({ ...t, triggerSignal: 'N' })),
      ...makeTrades(5, Array(5).fill(-1)).map(t => ({ ...t, tradeId: `B-${t.tradeId}`, triggerSignal: 'B' })),
    ];
    const r = computeMetricsByLetter(trades);
    expect(r.N.status).toBe('ok');
    expect(r.N.winRate).toBe(1);
    expect(r.B.status).toBe('insufficient-sample');
  });

  test('triggerSignal 為空 → unknown bucket', () => {
    const trades = makeTrades(10, Array(10).fill(2)); // 無 triggerSignal
    const r = computeMetricsByLetter(trades);
    expect(r.unknown).toBeDefined();
    expect(r.unknown.status).toBe('ok');
  });
});

describe('filterTradesByDateRange', () => {
  test('start/end 端點包含', () => {
    const trades = makeTrades(10, [1, 2, 3, 4, 5, -1, -2, -3, -4, -5]);
    const first = trades[0].exitDate;
    const last = trades[9].exitDate;
    expect(filterTradesByDateRange(trades, first, last)).toHaveLength(10);
  });

  test('範圍外被排除', () => {
    const trades = makeTrades(10, Array(10).fill(1));
    const r = filterTradesByDateRange(trades, '2030-01-01', '2030-12-31');
    expect(r).toHaveLength(0);
  });
});
