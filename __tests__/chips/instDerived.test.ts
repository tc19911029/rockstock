import { computeInstDerived, EMPTY_INST_DERIVED } from '@/lib/chips/instDerived';

// 工具：把 [foreign, trust] tuple 序列轉成升冪日序列
function rows(pairs: Array<[number, number]>): Array<{ date: string; foreign: number; trust: number }> {
  return pairs.map(([foreign, trust], i) => ({
    date: `2026-06-${String(i + 1).padStart(2, '0')}`,
    foreign,
    trust,
  }));
}

describe('computeInstDerived — 連續買超天數', () => {
  it('外資連 3 買、投信連 1 買', () => {
    const d = computeInstDerived(rows([[-100, 50], [200, -10], [300, 0], [150, 80]]), 10000);
    expect(d.foreignConsecBuyDays).toBe(3);
    expect(d.trustConsecBuyDays).toBe(1);
  });

  it('最新日賣超 → 0（不管之前連買幾天）', () => {
    const d = computeInstDerived(rows([[100, 100], [200, 200], [-50, -5]]), 10000);
    expect(d.foreignConsecBuyDays).toBe(0);
    expect(d.trustConsecBuyDays).toBe(0);
  });

  it('淨買 0（持平）中斷連續、最新日 0 也算 0', () => {
    // 外資：買/0/買 → 只算最新 1 天；投信最新日 0 → 0 天
    const d = computeInstDerived(rows([[100, 100], [0, 100], [100, 0]]), 10000);
    expect(d.foreignConsecBuyDays).toBe(1);
    expect(d.trustConsecBuyDays).toBe(0);
  });

  it('整段序列全買超 → 連買天數 = 序列長度', () => {
    const d = computeInstDerived(rows([[1, 1], [2, 2], [3, 3]]), 10000);
    expect(d.foreignConsecBuyDays).toBe(3);
    expect(d.trustConsecBuyDays).toBe(3);
  });
});

describe('computeInstDerived — 買賣超占成交量 %', () => {
  it('正常計算（1 位小數，單位皆「張」）', () => {
    // 外資 +2870 / 成交 10000 張 = +28.7%；投信 -333 / 10000 = -3.3%
    const d = computeInstDerived(rows([[2870, -333]]), 10000);
    expect(d.foreignNetToVolumePct).toBe(28.7);
    expect(d.trustNetToVolumePct).toBe(-3.3);
  });

  it('成交量缺（null / undefined）→ null', () => {
    expect(computeInstDerived(rows([[100, 50]]), null).foreignNetToVolumePct).toBeNull();
    expect(computeInstDerived(rows([[100, 50]]), undefined).trustNetToVolumePct).toBeNull();
  });

  it('成交量 0 或負 → null（不除以 0）', () => {
    expect(computeInstDerived(rows([[100, 50]]), 0).foreignNetToVolumePct).toBeNull();
    expect(computeInstDerived(rows([[100, 50]]), -5).trustNetToVolumePct).toBeNull();
  });

  it('NaN 成交量 → null', () => {
    expect(computeInstDerived(rows([[100, 50]]), NaN).foreignNetToVolumePct).toBeNull();
  });
});

describe('computeInstDerived — 外資+投信同步買超', () => {
  it('最新日兩者皆買 → instSyncBuy=true，連續同步天數正確', () => {
    // 同步買序列：d2(100,5) d3(50,10) → 2 天；d1 投信賣中斷
    const d = computeInstDerived(rows([[300, -1], [100, 5], [50, 10]]), 10000);
    expect(d.instSyncBuy).toBe(true);
    expect(d.instSyncBuyDays).toBe(2);
  });

  it('最新日只有單邊買 → instSyncBuy=false、天數 0', () => {
    const d = computeInstDerived(rows([[100, 100], [100, -5]]), 10000);
    expect(d.instSyncBuy).toBe(false);
    expect(d.instSyncBuyDays).toBe(0);
  });

  it('同步買天數 ≤ 各自連買天數', () => {
    const d = computeInstDerived(rows([[100, -1], [100, 1], [100, 1]]), 10000);
    expect(d.foreignConsecBuyDays).toBe(3);
    expect(d.trustConsecBuyDays).toBe(2);
    expect(d.instSyncBuyDays).toBe(2);
  });
});

describe('computeInstDerived — 邊界', () => {
  it('空序列 → 全部歸零 / null', () => {
    expect(computeInstDerived([], 10000)).toEqual(EMPTY_INST_DERIVED);
  });

  it('單筆買超序列', () => {
    const d = computeInstDerived(rows([[500, 100]]), 1000);
    expect(d).toEqual({
      foreignConsecBuyDays: 1,
      trustConsecBuyDays: 1,
      foreignNetToVolumePct: 50,
      trustNetToVolumePct: 10,
      instSyncBuy: true,
      instSyncBuyDays: 1,
    });
  });
});
