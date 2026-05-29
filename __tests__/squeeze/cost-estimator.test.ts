import { weightedShortCost, computeShortCosts } from '@/lib/squeeze/costEstimator';
import { marginCallPrice } from '@/lib/squeeze/marginCallPrice';
import type { MarginDay, SblDay, PriceDay } from '@/lib/squeeze/types';

describe('weightedShortCost', () => {
  it('manually verifies 5-day weighted average', () => {
    // Day 1: +100 lots @ 100 → 10000
    // Day 2: +200 lots @ 110 → 22000
    // Day 3:    0 lots @ 105 → 0
    // Day 4: +300 lots @ 120 → 36000
    // Day 5: -50  lots @ 115 → excluded
    // numerator = 68000, denominator = 600 → 113.333...
    const lots = [
      { date: 'd1', lots: 100 },
      { date: 'd2', lots: 200 },
      { date: 'd3', lots: 0 },
      { date: 'd4', lots: 300 },
      { date: 'd5', lots: -50 },
    ];
    const prices = new Map<string, number>([
      ['d1', 100], ['d2', 110], ['d3', 105], ['d4', 120], ['d5', 115],
    ]);
    expect(weightedShortCost(lots, prices)).toBeCloseTo(113.33, 1);
  });

  it('excludes negative net-add days from denominator', () => {
    const lots = [
      { date: 'a', lots: 100 },
      { date: 'b', lots: -200 },  // 回補天，不算
    ];
    const prices = new Map([['a', 50], ['b', 60]]);
    // 只算 a → 50
    expect(weightedShortCost(lots, prices)).toBe(50);
  });

  it('returns null when all days are zero/negative', () => {
    const lots = [
      { date: 'a', lots: 0 },
      { date: 'b', lots: -10 },
    ];
    expect(weightedShortCost(lots, new Map([['a', 100], ['b', 100]]))).toBeNull();
  });

  it('returns null when price missing for all positive days', () => {
    const lots = [{ date: 'a', lots: 100 }];
    expect(weightedShortCost(lots, new Map())).toBeNull();
  });
});

describe('marginCallPrice', () => {
  it('uses formula cost × (1 + margin) / 1.3 with default 90% margin', () => {
    // 100 × 1.9 / 1.3 = 146.1538...
    expect(marginCallPrice(100)).toBeCloseTo(146.15, 2);
  });
  it('returns null for null / invalid cost', () => {
    expect(marginCallPrice(null)).toBeNull();
    expect(marginCallPrice(0)).toBeNull();
    expect(marginCallPrice(NaN)).toBeNull();
  });
});

describe('computeShortCosts', () => {
  it('produces 5/10/20/60d buckets per track', () => {
    const margin: MarginDay[] = Array.from({ length: 60 }, (_, i) => ({
      date: `2025-${String(Math.floor(i / 31) + 1).padStart(2, '0')}-${String((i % 31) + 1).padStart(2, '0')}`,
      marginBalance: 1000 + i,
      marginNet: 0,
      shortBalance: 200 + i,
      shortNet: i % 2 === 0 ? 10 : -5,    // 偶數天 +10、奇數天 -5
      marginUtilRate: 0,
    }));
    const sbl: SblDay[] = margin.map(m => ({ date: m.date, lendingBalance: 50, lendingNet: 2 }));
    const prices: PriceDay[] = margin.map((m, i) => ({
      date: m.date,
      open: 100 + i, high: 102 + i, low: 99 + i, close: 101 + i,
      volume: 1_000_000, turnover: 101_000_000 + i, vwap: 100 + i,
    }));

    const cost = computeShortCosts(margin, sbl, prices);
    // 每個格子應該有值
    expect(cost.margin.d5).not.toBeNull();
    expect(cost.sbl.d5).not.toBeNull();
    expect(cost.combined.d60).not.toBeNull();
  });
});
