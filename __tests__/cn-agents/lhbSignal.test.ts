import { lhbSignal } from '@/lib/cn-agents/lhbSignal';
import type { LhbStockEntry } from '@/lib/cn-agents/types';

function mk(p: Partial<LhbStockEntry>): LhbStockEntry {
  return {
    code: '000001', name: 'X', board: 'SZ-main', close: 10, changeRate: 0, reason: '',
    tradeId: null, netAmt: 0, buyAmt: 0, sellAmt: 0, accumAmount: 0, freeMarketCap: 0, turnoverRate: 0,
    fwd: { d1: null, d2: null, d5: null, d10: null },
    seats: { buy: [], sell: [] },
    seatSummary: { hotMoneyBuyCount: 0, institutionBuyCount: 0, institutionSellCount: 0, retailProxyBuyCount: 0, quantBuyCount: 0, northboundBuyCount: 0, buyOneDominance: null },
    ...p,
  };
}

describe('lhbSignal（回測訊號排序）', () => {
  it('漲多 + 淨買 → good、排前', () => {
    const r = lhbSignal(mk({ reason: '日涨幅偏离值达7%的前5只证券', netAmt: 3.6e8 }));
    expect(r.verdict).toBe('good');
    expect(r.score).toBe(3);
    expect(r.warnings).toEqual([]);
  });

  it('跌多 + 淨賣 → avoid、標紅（彩虹股份型）', () => {
    const r = lhbSignal(mk({ reason: '连续三个交易日内跌幅偏离值累计达20%', netAmt: -5.97e8 }));
    expect(r.verdict).toBe('avoid');
    expect(r.warnings).toContain('跌多上榜');
    expect(r.warnings).toContain('淨賣超');
  });

  it('拉薩在買 → 扣分 + 警告', () => {
    const r = lhbSignal(mk({ reason: '日涨幅偏离值达7%', netAmt: 1e8, seatSummary: { ...mk({}).seatSummary, retailProxyBuyCount: 2 } }));
    expect(r.warnings).toContain('拉薩在買');
  });

  it('機構買不額外加分（回測證明沒用）', () => {
    const withInst = lhbSignal(mk({ reason: '日涨幅偏离值达7%', netAmt: 1e8, seatSummary: { ...mk({}).seatSummary, institutionBuyCount: 3 } }));
    const without = lhbSignal(mk({ reason: '日涨幅偏离值达7%', netAmt: 1e8 }));
    expect(withInst.score).toBe(without.score);
  });
});
