/**
 * Contract test：swap-suggestion 排序規則 + 集中度警示
 *
 * 守的規則：
 *   - 10 條 priority 規則的命中順序固定（top-down）
 *   - 同 priority tiebreaker：netReturnPct asc → proceedsNet desc
 *   - 無 currentPrice 的 holding 不參與排序
 *   - hold_strong 永遠 priority 9（最不該賣）
 *   - 課程 CH11-1：小賠（7）必須排在小賺（8）之前 — 汰弱換強
 *   - estimateBuyShares 必須按 lot size 對齊（TW 1000 / CN 100）
 *   - 同產業集中度警示必出
 */

import {
  rankHoldingsForSwap,
  recommendSwap,
  estimateBuyShares,
  type HoldingForSwap,
} from '@/lib/portfolio/swapSuggestion';
import type { PortfolioHoldingReview } from '@/lib/agents/portfolio/types';

function makeHolding(o: Partial<HoldingForSwap> = {}): HoldingForSwap {
  return {
    symbol: '2408.TW',
    name: '南亞科',
    market: 'TW',
    industry: '半導體 - DRAM',
    entryDate: '2026-05-20',
    entryPrice: 200,
    shares: 6000,
    stopLoss: 186,
    ...o,
  };
}

function makeReview(o: Partial<PortfolioHoldingReview> = {}): PortfolioHoldingReview {
  return {
    symbol: '2408.TW',
    name: '南亞科',
    market: 'TW',
    entryDate: '2026-05-20',
    entryPrice: 200,
    shares: 6000,
    currentPrice: 220,
    returnPct: 10,
    daysHeld: 3,
    technical: { verdict: 'pass', overview: 'x', verdictReason: 'y' },
    risk: { verdict: 'green', overview: 'x', verdictReason: 'y' },
    news: { verdict: 'watch', overview: 'x', verdictReason: 'y' },
    action: 'hold_strong',
    actionPath: 'tech_pass_green',
    reasoning: 'z',
    keyPriceLevels: {},
    ...o,
  };
}

describe('rankHoldingsForSwap — priority rules', () => {
  test('priority 1: risk=red → 第一個賣', () => {
    const ranked = rankHoldingsForSwap({
      holdings: [makeHolding({ symbol: 'A.TW' }), makeHolding({ symbol: 'B.TW' })],
      currentPrices: new Map([['A.TW', 220], ['B.TW', 220]]),
      reviewsBySymbol: new Map([
        ['A.TW', makeReview({ symbol: 'A.TW', action: 'hold_strong', actionPath: 'tech_pass_green' })],
        ['B.TW', makeReview({
          symbol: 'B.TW', action: 'stop_loss', actionPath: 'risk_red_stop',
          risk: { verdict: 'red', overview: '', verdictReason: '戒律觸發' },
        })],
      ]),
    });
    expect(ranked[0].sellSymbol).toBe('B.TW');
    expect(ranked[0].priority).toBe(1);
    expect(ranked[0].reasonPath).toBe('risk_red_force');
  });

  test('priority 2: take_profit → 第二優先', () => {
    const ranked = rankHoldingsForSwap({
      holdings: [makeHolding({ symbol: 'A.TW' }), makeHolding({ symbol: 'B.TW' })],
      currentPrices: new Map([['A.TW', 220], ['B.TW', 220]]),
      reviewsBySymbol: new Map([
        ['A.TW', makeReview({ symbol: 'A.TW', action: 'hold_strong', actionPath: 'tech_pass_green' })],
        ['B.TW', makeReview({ symbol: 'B.TW', action: 'take_profit', actionPath: 'target1_hit' })],
      ]),
    });
    expect(ranked[0].sellSymbol).toBe('B.TW');
    expect(ranked[0].priority).toBe(2);
    expect(ranked[0].reasonPath).toBe('target_hit_profit_lock');
  });

  test('priority 3: action=reduce (technical_fail)', () => {
    const ranked = rankHoldingsForSwap({
      holdings: [makeHolding({ symbol: 'A.TW' })],
      currentPrices: new Map([['A.TW', 220]]),
      reviewsBySymbol: new Map([
        ['A.TW', makeReview({
          symbol: 'A.TW', action: 'reduce', actionPath: 'technical_fail',
          technical: { verdict: 'fail', overview: '', verdictReason: '空頭結構' },
        })],
      ]),
    });
    expect(ranked[0].priority).toBe(3);
    expect(ranked[0].reasonPath).toBe('technical_fail_reduce');
  });

  test('priority 4: 距停損 ≤ 3%（無 review）', () => {
    const ranked = rankHoldingsForSwap({
      holdings: [makeHolding({ stopLoss: 200, entryPrice: 200 })], // stopLoss=entry, 接近停損
      currentPrices: new Map([['2408.TW', 205]]), // 距停損 2.5%
      reviewsBySymbol: new Map(),
    });
    expect(ranked[0].priority).toBe(4);
    expect(ranked[0].reasonPath).toBe('near_stop_loss');
    expect(ranked[0].distanceToStopPct).toBeCloseTo(2.5, 1);
  });

  test('priority 5: deep underwater (含費 < -5%)', () => {
    const ranked = rankHoldingsForSwap({
      holdings: [makeHolding({ entryPrice: 200, stopLoss: 150 })],
      currentPrices: new Map([['2408.TW', 180]]), // 約 -10%
      reviewsBySymbol: new Map(),
    });
    expect(ranked[0].priority).toBe(5);
    expect(ranked[0].reasonPath).toBe('deep_underwater');
    expect(ranked[0].netReturnPct).toBeLessThan(-5);
  });

  test('priority 6: hold_observe → 中性可換', () => {
    const ranked = rankHoldingsForSwap({
      holdings: [makeHolding()],
      currentPrices: new Map([['2408.TW', 210]]),
      reviewsBySymbol: new Map([
        ['2408.TW', makeReview({ action: 'hold_observe', actionPath: 'tech_watch' })],
      ]),
    });
    expect(ranked[0].priority).toBe(6);
    expect(ranked[0].reasonPath).toBe('hold_observe_neutral');
  });

  // 2026-07-20 第七輪：新增 priority 7「小賠先走」（課程 CH11-1 汰弱換強），8/9/10 往後推
  test('priority 7: 小賠（含費 < 0，未達深水 -5%）→ 排在小賺之前', () => {
    const ranked = rankHoldingsForSwap({
      holdings: [makeHolding({ entryPrice: 200, stopLoss: 150 })],
      currentPrices: new Map([['2408.TW', 196]]), // -2% gross
      reviewsBySymbol: new Map(),
    });
    expect(ranked[0].priority).toBe(7);
    expect(ranked[0].reasonPath).toBe('underwater_small');
  });

  test('課程 CH11-1：小賠必須排在小賺之前（賺 1% 也抱、走弱的先淘汰）', () => {
    const ranked = rankHoldingsForSwap({
      holdings: [
        makeHolding({ symbol: '1111.TW', entryPrice: 200, stopLoss: 150 }),
        makeHolding({ symbol: '2222.TW', entryPrice: 200, stopLoss: 150 }),
      ],
      currentPrices: new Map([
        ['1111.TW', 204], // 小賺
        ['2222.TW', 196], // 小賠
      ]),
      reviewsBySymbol: new Map(),
    });
    expect(ranked[0].sellSymbol).toBe('2222.TW'); // 小賠先賣
    expect(ranked[0].reasonPath).toBe('underwater_small');
  });

  test('priority 8: 小賺 0 < netReturnPct < 5%', () => {
    const ranked = rankHoldingsForSwap({
      holdings: [makeHolding({ entryPrice: 200, stopLoss: 150 })],
      currentPrices: new Map([['2408.TW', 204]]), // +2% gross；含費 1.4%
      reviewsBySymbol: new Map(),
    });
    expect(ranked[0].priority).toBe(8);
    expect(ranked[0].reasonPath).toBe('small_gain_lock');
  });

  test('priority 9: hold_strong → 最不該賣', () => {
    const ranked = rankHoldingsForSwap({
      holdings: [makeHolding()],
      currentPrices: new Map([['2408.TW', 210]]),
      reviewsBySymbol: new Map([
        ['2408.TW', makeReview({ action: 'hold_strong', actionPath: 'tech_pass_green' })],
      ]),
    });
    expect(ranked[0].priority).toBe(9);
    expect(ranked[0].reasonPath).toBe('strong_hold_keep');
  });

  test('priority 10: 無 review + 獲利已超過小賺級（無明顯信號）', () => {
    const ranked = rankHoldingsForSwap({
      holdings: [makeHolding({ entryPrice: 200, stopLoss: 150 })],
      currentPrices: new Map([['2408.TW', 215]]), // +7.5% gross，超過小賺 5% 級
      reviewsBySymbol: new Map(),
    });
    expect(ranked[0].priority).toBe(10);
    expect(ranked[0].reasonPath).toBe('unknown_default');
  });

  test('Tiebreaker: 同 priority 時 netReturnPct asc 先賣（賠多先賣）', () => {
    const ranked = rankHoldingsForSwap({
      holdings: [
        makeHolding({ symbol: 'A.TW', entryPrice: 200 }),
        makeHolding({ symbol: 'B.TW', entryPrice: 200 }),
      ],
      currentPrices: new Map([['A.TW', 198], ['B.TW', 195]]), // B 賠較多
      reviewsBySymbol: new Map([
        ['A.TW', makeReview({ symbol: 'A.TW', action: 'hold_observe', actionPath: 'tech_watch' })],
        ['B.TW', makeReview({ symbol: 'B.TW', action: 'hold_observe', actionPath: 'tech_watch' })],
      ]),
    });
    expect(ranked[0].sellSymbol).toBe('B.TW');
  });

  test('Tiebreaker 2: 同 priority + 同 returnPct → proceedsNet desc（部位大的先賣）', () => {
    const ranked = rankHoldingsForSwap({
      holdings: [
        makeHolding({ symbol: 'A.TW', shares: 1000 }),
        makeHolding({ symbol: 'B.TW', shares: 5000 }),
      ],
      currentPrices: new Map([['A.TW', 210], ['B.TW', 210]]),
      reviewsBySymbol: new Map([
        ['A.TW', makeReview({ symbol: 'A.TW', action: 'hold_observe', actionPath: 'x' })],
        ['B.TW', makeReview({ symbol: 'B.TW', action: 'hold_observe', actionPath: 'x' })],
      ]),
    });
    expect(ranked[0].sellSymbol).toBe('B.TW');
  });

  test('無 currentPrice 的 holding 被排除', () => {
    const ranked = rankHoldingsForSwap({
      holdings: [
        makeHolding({ symbol: 'A.TW' }),
        makeHolding({ symbol: 'B.TW' }),
      ],
      currentPrices: new Map([['A.TW', 220]]),  // B 沒價
      reviewsBySymbol: new Map(),
    });
    expect(ranked).toHaveLength(1);
    expect(ranked[0].sellSymbol).toBe('A.TW');
  });
});

describe('recommendSwap', () => {
  test('空 holdings → noActionRecommended', () => {
    const r = recommendSwap({
      candidate: { symbol: '2330.TW', name: '台積電', entryPrice: 1100 },
      holdings: [],
      currentPrices: new Map(),
      reviewsBySymbol: new Map(),
    });
    expect(r.noActionRecommended).toBe(true);
    expect(r.reason).toBe('no_open_holdings');
    expect(r.recommended).toBeNull();
  });

  test('產業集中度警示：同產業全 match', () => {
    const r = recommendSwap({
      candidate: { symbol: '2330.TW', name: '台積電', entryPrice: 1100, industry: '半導體 - 晶圓代工' },
      holdings: [
        makeHolding({ symbol: 'A.TW', industry: '半導體 - DRAM' }),
        makeHolding({ symbol: 'B.TW', industry: '半導體 - IC 設計' }),
      ],
      currentPrices: new Map([['A.TW', 210], ['B.TW', 210]]),
      reviewsBySymbol: new Map(),
    });
    expect(r.warnings.some(w => w.includes('產業集中度'))).toBe(true);
  });

  test('釋出資金不足警示', () => {
    const r = recommendSwap({
      candidate: { symbol: '2330.TW', name: '台積電', entryPrice: 1100, targetInvestment: 100_000_000 },
      holdings: [makeHolding({ shares: 1000 })], // 賣最多釋出 ~21 萬
      currentPrices: new Map([['2408.TW', 210]]),
      reviewsBySymbol: new Map(),
    });
    expect(r.warnings.some(w => w.includes('釋出資金不足'))).toBe(true);
  });

  test('缺 review 警示', () => {
    const r = recommendSwap({
      candidate: { symbol: '2330.TW', name: '台積電', entryPrice: 1100 },
      holdings: [makeHolding({ symbol: 'A.TW' }), makeHolding({ symbol: 'B.TW' })],
      currentPrices: new Map([['A.TW', 210], ['B.TW', 210]]),
      reviewsBySymbol: new Map(),  // 完全沒 review
    });
    expect(r.warnings.some(w => w.includes('缺最近 review'))).toBe(true);
  });

  test('alternatives 最多 2 筆', () => {
    const r = recommendSwap({
      candidate: { symbol: '2330.TW', name: '台積電', entryPrice: 1100 },
      holdings: [
        makeHolding({ symbol: 'A.TW' }),
        makeHolding({ symbol: 'B.TW' }),
        makeHolding({ symbol: 'C.TW' }),
        makeHolding({ symbol: 'D.TW' }),
      ],
      currentPrices: new Map([['A.TW', 210], ['B.TW', 210], ['C.TW', 210], ['D.TW', 210]]),
      reviewsBySymbol: new Map(),
    });
    expect(r.alternatives.length).toBeLessThanOrEqual(2);
  });

  test('sizeFit：targetInvestment 提供時，挑剛好覆蓋的最小部位', () => {
    const r = recommendSwap({
      candidate: { symbol: '2330.TW', name: '台積電', entryPrice: 1100, targetInvestment: 5_500_000 },
      holdings: [
        // big 部位 (priority 2 take_profit, 高 returnPct)：6800 萬 — 訊號最強且 12x 超出
        makeHolding({ symbol: 'BIG.TW', shares: 14000, entryPrice: 3000 }),
        // fit 部位 (priority 6 hold_observe)：560 萬 — 剛好覆蓋 5.5M
        makeHolding({ symbol: 'FIT.TW', shares: 88000, entryPrice: 63, stopLoss: 50 }),
      ],
      currentPrices: new Map([
        ['BIG.TW', 4895],
        ['FIT.TW', 63.8],
      ]),
      reviewsBySymbol: new Map([
        ['BIG.TW', makeReview({ symbol: 'BIG.TW', action: 'take_profit', actionPath: 'target1_hit' })],
        ['FIT.TW', makeReview({ symbol: 'FIT.TW', action: 'hold_observe', actionPath: 'tech_watch' })],
      ]),
    });
    // recommended 走訊號（priority 2 BIG）
    expect(r.recommended?.sellSymbol).toBe('BIG.TW');
    // sizeFit 應為 FIT（剛好覆蓋 5.5M）
    expect(r.sizeFit?.sellSymbol).toBe('FIT.TW');
    // warnings 應提示訊號與 size 衝突（BIG 釋出 6800 萬 >> 5.5M target）
    expect(r.warnings.some(w => w.includes('超出目標'))).toBe(true);
  });

  test('sizeFit：無 targetInvestment → null', () => {
    const r = recommendSwap({
      candidate: { symbol: '2330.TW', name: '台積電', entryPrice: 1100 },
      holdings: [makeHolding()],
      currentPrices: new Map([['2408.TW', 210]]),
      reviewsBySymbol: new Map(),
    });
    expect(r.sizeFit).toBeNull();
  });

  test('sizeFit：所有部位都不夠覆蓋 → 取最大部位 + warning', () => {
    const r = recommendSwap({
      candidate: { symbol: '2330.TW', name: '台積電', entryPrice: 1100, targetInvestment: 100_000_000 },
      holdings: [
        makeHolding({ symbol: 'A.TW', shares: 1000 }),
        makeHolding({ symbol: 'B.TW', shares: 5000 }),
      ],
      currentPrices: new Map([['A.TW', 210], ['B.TW', 210]]),
      reviewsBySymbol: new Map(),
    });
    // 都不夠 100M；sizeFit 取 proceedsNet 最大的（B）
    expect(r.sizeFit?.sellSymbol).toBe('B.TW');
    expect(r.warnings.some(w => w.includes('釋出資金不足'))).toBe(true);
  });
});

describe('estimateBuyShares', () => {
  test('TW lot size 1000：5,589,577 NTD / 1100 元 → 5000 股 = 5 張', () => {
    const r = estimateBuyShares(5_589_577, { entryPrice: 1100, market: 'TW' });
    expect(r.shares).toBe(5000);
    expect(r.lots).toBe(5);
    expect(r.totalCost).toBe(5_500_000);
    expect(r.remainingCash).toBeGreaterThan(0); // 應有剩餘
  });

  test('CN lot size 100', () => {
    const r = estimateBuyShares(100_000, { entryPrice: 50, market: 'CN' });
    // raw shares = 2000, lots = 20, shares = 2000
    expect(r.shares).toBe(2000);
    expect(r.lots).toBe(20);
  });

  test('資金不夠買 1 lot → 0 股', () => {
    const r = estimateBuyShares(500_000, { entryPrice: 1100, market: 'TW' });
    // raw = 454; lots = 0
    expect(r.shares).toBe(0);
    expect(r.lots).toBe(0);
    expect(r.totalCost).toBe(0);
  });

  test('包含買進手續費（remainingCash 已扣）', () => {
    const r = estimateBuyShares(5_589_577, { entryPrice: 1100, market: 'TW' });
    // totalCost 5,500,000; buyFee = 5,500,000 × 0.001425 = 7,838
    // remainingCash = 5,589,577 - 5,500,000 - 7,838 = 81,739
    expect(r.remainingCash).toBeCloseTo(81_739, 0);
  });
});
