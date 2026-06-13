/**
 * seatStats 全量重建 — 純 fixture 單元測試
 */

import { buildSeatStats } from '@/lib/cn-agents/seatStats';
import type { LhbDailyFile, LhbStockEntry, SeatRegistryFile, SeatTrade } from '@/lib/cn-agents/types';

const REGISTRY: SeatRegistryFile = { schemaVersion: 1, updatedAt: '2026-06-13T00:00:00Z', seats: [] };

function seat(deptCode: string, deptName: string, buyAmt: number | null, sellAmt: number | null): SeatTrade {
  return {
    deptCode,
    deptName,
    buyAmt,
    sellAmt,
    netAmt: buyAmt !== null || sellAmt !== null ? (buyAmt ?? 0) - (sellAmt ?? 0) : null,
    type: 'unknown',
    label: null,
  };
}

function stock(
  code: string,
  name: string,
  fwd: { d1: number | null; d5: number | null },
  buys: SeatTrade[],
  sells: SeatTrade[] = [],
): LhbStockEntry {
  return {
    code,
    name,
    board: 'SZ-main',
    close: 10,
    changeRate: 10,
    reason: '日漲幅偏離值達7%',
    tradeId: null,
    netAmt: 1e8,
    buyAmt: 2e8,
    sellAmt: 1e8,
    accumAmount: 5e8,
    freeMarketCap: 50e8,
    turnoverRate: 10,
    fwd: { d1: fwd.d1, d2: null, d5: fwd.d5, d10: null },
    seats: { buy: buys, sell: sells },
    seatSummary: {
      hotMoneyBuyCount: 0,
      institutionBuyCount: 0,
      institutionSellCount: 0,
      retailProxyBuyCount: 0,
      quantBuyCount: 0,
      northboundBuyCount: 0,
      buyOneDominance: null,
    },
  };
}

function day(date: string, stocks: LhbStockEntry[]): LhbDailyFile {
  return { schemaVersion: 1, date, fetchedAt: `${date}T12:00:00Z`, detailFetched: true, stocks };
}

describe('buildSeatStats', () => {
  it('基本聚合：nBuy/nSell/買入前瞻均值與勝率', () => {
    const files = [
      day('2026-06-08', [stock('000001', '平安银行', { d1: 2, d5: 5 }, [seat('A1', '營業部甲', 1e7, null)])]),
      day('2026-06-09', [stock('000002', '万科A', { d1: -1, d5: -3 }, [seat('A1', '營業部甲', 2e7, null)])]),
    ];
    const stats = buildSeatStats(files, REGISTRY, new Map());
    const a1 = stats.seats.find((s) => s.deptCode === 'A1')!;
    expect(a1.nBuy).toBe(2);
    expect(a1.nSell).toBe(0);
    expect(a1.nEvents).toBe(2);
    expect(a1.buyFwd.avgD1).toBeCloseTo(0.5, 3); // (2 + −1)/2
    expect(a1.buyFwd.winD1).toBeCloseTo(0.5, 3);
    expect(a1.buyFwd.avgD5).toBeCloseTo(1, 3);
    expect(a1.lastSeen).toBe('2026-06-09');
  });

  it('隔日砸盤率：買入後次一有檔日出現在同股賣方', () => {
    const files = [
      day('2026-06-08', [stock('000001', '平安银行', { d1: null, d5: null }, [seat('B1', '營業部乙', 1e7, null)])]),
      day('2026-06-09', [
        stock('000001', '平安银行', { d1: null, d5: null }, [], [seat('B1', '營業部乙', null, 8e6)]),
      ]),
      // 第二筆買入在視窗最後一日 → 無從判定（不入 dumpEligible 分母）
      day('2026-06-10', [stock('000003', '其他股', { d1: null, d5: null }, [seat('B1', '營業部乙', 5e6, null)])]),
    ];
    const stats = buildSeatStats(files, REGISTRY, new Map());
    const b1 = stats.seats.find((s) => s.deptCode === 'B1')!;
    expect(b1.nBuy).toBe(2);
    // dumpEligible = 1（06-08 買入；06-10 買入在最後一日不可判）→ 砸 1/1
    expect(b1.nextDayDumpRate).toBeCloseTo(1, 3);
  });

  it('隔日同股沒上榜 → 不算砸（榜面可見性限制）', () => {
    const files = [
      day('2026-06-08', [stock('000001', '平安银行', { d1: null, d5: null }, [seat('C1', '營業部丙', 1e7, null)])]),
      day('2026-06-09', [stock('000002', '万科A', { d1: null, d5: null }, [seat('Z9', '路人席位', 1e7, null)])]),
    ];
    const stats = buildSeatStats(files, REGISTRY, new Map());
    const c1 = stats.seats.find((s) => s.deptCode === 'C1')!;
    expect(c1.nextDayDumpRate).toBeCloseTo(0, 3);
  });

  it('內建規則貼標：機構專用 → institution', () => {
    const files = [
      day('2026-06-08', [stock('000001', '平安银行', { d1: 1, d5: 1 }, [seat('I1', '机构专用', 1e7, null)])]),
    ];
    const stats = buildSeatStats(files, REGISTRY, new Map());
    expect(stats.seats.find((s) => s.deptCode === 'I1')!.type).toBe('institution');
  });

  it('fwd 全 null → 均值/勝率 null 不為 NaN；topIndustries join', () => {
    const files = [
      day('2026-06-08', [stock('000001', '平安银行', { d1: null, d5: null }, [seat('D1', '營業部丁', 1e7, null)])]),
    ];
    const stats = buildSeatStats(files, REGISTRY, new Map([['000001', '銀行']]));
    const d1 = stats.seats.find((s) => s.deptCode === 'D1')!;
    expect(d1.buyFwd.avgD1).toBeNull();
    expect(d1.buyFwd.winD1).toBeNull();
    expect(d1.nextDayDumpRate).toBeNull(); // 視窗最後一日買入 → eligible 0
    expect(d1.topIndustries).toEqual([{ industry: '銀行', n: 1 }]);
  });

  it('視窗欄位與排序：nEvents 降冪、windowFrom/To', () => {
    const files = [
      day('2026-06-09', [stock('000002', '万科A', { d1: 1, d5: 1 }, [seat('E1', '常客', 1e7, null), seat('E2', '過客', 1e7, null)])]),
      day('2026-06-08', [stock('000001', '平安银行', { d1: 1, d5: 1 }, [seat('E1', '常客', 1e7, null)])]),
    ];
    const stats = buildSeatStats(files, REGISTRY, new Map());
    expect(stats.windowFrom).toBe('2026-06-08');
    expect(stats.windowTo).toBe('2026-06-09');
    expect(stats.seats[0].deptCode).toBe('E1');
  });
});
