/**
 * ETF 體檢（課程 CH12）成分股重疊度純函式測試。
 * 鎖住：重疊度計算、集中榜加總、空 symbol 佔位不併成假集中股。
 */
import {
  computeSharedHoldings,
  computeOverlapPairs,
  overlapLevel,
  type ETFHoldingsInput,
} from '@/lib/etf/ch12Diagnostics';

function etf(code: string, holdings: Array<[string, string, number]>): ETFHoldingsInput {
  return {
    etfCode: code,
    etfName: code,
    disclosureDate: '2026-07-08',
    holdings: holdings.map(([symbol, name, weight]) => ({ symbol, name, weight })),
  };
}

describe('ch12Diagnostics — 成分股重疊度', () => {
  it('computeOverlapPairs：前 N 大重疊度 = 共同檔數 / effectiveN', () => {
    const a = etf('A', [['2330', '台積電', 30], ['2454', '聯發科', 20], ['2317', '鴻海', 10]]);
    const b = etf('B', [['2330', '台積電', 25], ['2454', '聯發科', 15], ['3008', '大立光', 5]]);
    const [pair] = computeOverlapPairs([a, b], 3);
    expect(pair.sharedCount).toBe(2); // 2330, 2454
    expect(pair.overlapPct).toBeCloseTo(66.7, 1); // 2/3
    expect(pair.sharedNames).toEqual(['台積電', '聯發科']); // 依 A 權重排序
  });

  it('effectiveN 取兩邊實際檔數的較小值（持股不足 topN）', () => {
    const a = etf('A', [['2330', '台積電', 30], ['2454', '聯發科', 20]]);
    const b = etf('B', [['2330', '台積電', 25]]);
    const [pair] = computeOverlapPairs([a, b], 10);
    expect(pair.sharedCount).toBe(1);
    expect(pair.overlapPct).toBe(100); // 1 / min(10,2,1)=1
  });

  it('computeSharedHoldings：集中榜依被持有檔數排序、加總/平均權重正確', () => {
    const a = etf('A', [['2330', '台積電', 30], ['2454', '聯發科', 20]]);
    const b = etf('B', [['2330', '台積電', 25], ['2317', '鴻海', 10]]);
    const c = etf('C', [['2330', '台積電', 20], ['2454', '聯發科', 15]]);
    const shared = computeSharedHoldings([a, b, c], 10);
    const t = shared.find((s) => s.symbol === '2330')!;
    expect(t.count).toBe(3);
    expect(t.totalWeight).toBeCloseTo(75, 5);
    expect(t.avgWeight).toBeCloseTo(25, 5);
    expect(shared[0].symbol).toBe('2330'); // 被最多檔持有排最前
  });

  it('空／空白 symbol 佔位（現金、其他）不會跨 ETF 併成假的集中持股', () => {
    const a = etf('A', [['', '現金', 5], ['2330', '台積電', 30]]);
    const b = etf('B', [['', '其他', 4], ['2330', '台積電', 25]]);
    const shared = computeSharedHoldings([a, b], 10);
    expect(shared.some((s) => s.symbol === '')).toBe(false);
    expect(shared.find((s) => s.symbol === '2330')!.count).toBe(2);
  });

  it('overlapLevel 分級：70%+ high / 40%+ medium / 其餘 low', () => {
    expect(overlapLevel(90)).toBe('high');
    expect(overlapLevel(70)).toBe('high');
    expect(overlapLevel(55)).toBe('medium');
    expect(overlapLevel(40)).toBe('medium');
    expect(overlapLevel(30)).toBe('low');
  });
});
