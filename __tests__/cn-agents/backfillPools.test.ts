/**
 * backfillPools — 日K 重建漲停/炸板/跌停池 單元測試
 *
 * 合成 fixture 直餵 reconstructPools（純函式零 IO），覆蓋：
 * 精確封板進位 / 炸板 / 跌停連續計數 / 一字板 / 連板計數與 lead-in /
 * 停牌跳日的次日報酬歸屬 / ST 5% / 創業板 20cm（含 ST 仍 20%）/ 家數統計
 */

import {
  reconstructPools,
  exactLimitUpPrice,
  exactLimitDownPrice,
  type BackfillSeriesBar,
  type BackfillSymbolMeta,
} from '@/lib/cn-agents/backfillPools';

const bar = (date: string, open: number, high: number, low: number, close: number): BackfillSeriesBar => ({
  date, open, high, low, close,
});

/** 單一 symbol 的便捷重建（多數 case 只看一檔） */
function reconOne(
  meta: BackfillSymbolMeta,
  series: BackfillSeriesBar[],
  from: string,
  to: string,
) {
  return reconstructPools({
    metas: [meta],
    loadSeries: () => series,
    from,
    to,
  });
}

describe('exactLimitUpPrice / exactLimitDownPrice — 交易所精確進位', () => {
  it('round(prevClose×1.1, 2)：5.67 → 6.24（非 6.23，浮點 5.67×1.1=6.237…要四捨五入到分）', () => {
    expect(exactLimitUpPrice(5.67, 0.1)).toBe(6.24);
    expect(exactLimitUpPrice(10, 0.1)).toBe(11);
    expect(exactLimitUpPrice(4, 0.05)).toBe(4.2);
    expect(exactLimitUpPrice(10, 0.2)).toBe(12);
  });
  it('跌停對稱：round(prevClose×0.9, 2)', () => {
    expect(exactLimitDownPrice(10, 0.1)).toBe(9);
    expect(exactLimitDownPrice(9, 0.1)).toBe(8.1);
    expect(exactLimitDownPrice(5.67, 0.1)).toBe(5.1); // 5.103 → 5.10
  });
});

describe('reconstructPools — 精確封板判定', () => {
  const meta: BackfillSymbolMeta = { symbol: '600100.SS', name: '同方股份', industry: '計算機設備' };

  it('close 正好封在精確漲停價 → limitUp；差一分錢（tick 容忍版會誤收）→ 不是', () => {
    // 5.67 → 漲停價 6.24；D2 收 6.24 封板、D3（以 6.24 為基準 → 6.86）收 6.85 差一分 → 非漲停
    const series = [
      bar('2026-04-01', 5.6, 5.7, 5.55, 5.67),
      bar('2026-04-02', 5.8, 6.24, 5.75, 6.24),
      bar('2026-04-03', 6.5, 6.85, 6.4, 6.85),
    ];
    const out = reconOne(meta, series, '2026-04-02', '2026-04-03');
    const d2 = out.get('2026-04-02')!;
    expect(d2.limitUp).toHaveLength(1);
    expect(d2.limitUp[0]).toMatchObject({ symbol: '600100', board: 'SH-main', consecBoards: 1, isST: false });
    const d3 = out.get('2026-04-03')!;
    expect(d3.limitUp).toHaveLength(0);
    // 6.85 < 6.86 也沒觸停 → 不是炸板
    expect(d3.broken).toHaveLength(0);
  });

  it('盤中觸停（high ≥ 漲停價）但收盤未封 → broken（炸板）', () => {
    const series = [
      bar('2026-04-01', 10, 10.2, 9.9, 10),
      bar('2026-04-02', 10.5, 11, 10.4, 10.7), // 觸 11.00 收 10.7
    ];
    const out = reconOne(meta, series, '2026-04-02', '2026-04-02');
    const d = out.get('2026-04-02')!;
    expect(d.limitUp).toHaveLength(0);
    expect(d.broken).toHaveLength(1);
    expect(d.broken[0]).toMatchObject({ symbol: '600100', pct: expect.closeTo(7, 5) });
  });

  it('跌停 + 連續跌停計數（consecDownBoards）', () => {
    const series = [
      bar('2026-04-01', 10, 10.1, 9.9, 10),
      bar('2026-04-02', 9.5, 9.5, 9, 9),     // 跌停 9.00（1 連）
      bar('2026-04-03', 8.5, 8.5, 8.1, 8.1), // 跌停 8.10（2 連）
    ];
    const out = reconOne(meta, series, '2026-04-02', '2026-04-03');
    expect(out.get('2026-04-02')!.limitDown[0].consecDownBoards).toBe(1);
    expect(out.get('2026-04-03')!.limitDown[0].consecDownBoards).toBe(2);
  });

  it('一字板 proxy：O=H=L=C 且漲停 → isOneWord=true；普通封板 → false', () => {
    const series = [
      bar('2026-04-01', 10, 10.1, 9.9, 10),
      bar('2026-04-02', 11, 11, 11, 11),        // 一字
      bar('2026-04-03', 11.5, 12.1, 11.4, 12.1), // 普通封板（12.10）
    ];
    const out = reconOne(meta, series, '2026-04-02', '2026-04-03');
    expect(out.get('2026-04-02')!.limitUp[0].isOneWord).toBe(true);
    expect(out.get('2026-04-03')!.limitUp[0].isOneWord).toBe(false);
  });

  it('連板計數含 from 之前的 lead-in（from 前一日已首板 → from 日封板 = 2 連板）', () => {
    const series = [
      bar('2026-04-01', 10, 10.1, 9.9, 10),
      bar('2026-04-02', 10.8, 11, 10.7, 11),     // 首板（from 之前）
      bar('2026-04-03', 11.5, 12.1, 11.4, 12.1), // 2 連板（from 日）
    ];
    const out = reconOne(meta, series, '2026-04-03', '2026-04-03');
    expect(out.has('2026-04-02')).toBe(false); // from 之前不輸出池子
    expect(out.get('2026-04-03')!.limitUp[0].consecBoards).toBe(2);
    // lead-in 漲停的次日報酬也歸屬到 from 日（跨界自然接上）
    expect(out.get('2026-04-03')!.yestLimitUpReturns).toEqual([expect.closeTo(10, 5)]);
  });

  it('停牌跳日：漲停次根隔了停牌日，報酬歸屬到「該股自身次根」的日期', () => {
    const series = [
      bar('2026-04-01', 10, 10.1, 9.9, 10),
      bar('2026-04-02', 10.8, 11, 10.7, 11), // 漲停；之後 04-03 停牌無 bar
      bar('2026-04-06', 11.2, 11.5, 10.9, 11.55), // 復牌次根（+5%）
    ];
    const out = reconOne(meta, series, '2026-04-02', '2026-04-07');
    expect(out.get('2026-04-06')!.yestLimitUpReturns).toEqual([expect.closeTo(5, 5)]);
    // 停牌中的 04-03 沒有任何歸屬
    expect(out.get('2026-04-03')).toBeUndefined();
  });

  it('炸板股次日報酬 → yestBrokenReturns（虧錢效應）', () => {
    const series = [
      bar('2026-04-01', 10, 10.2, 9.9, 10),
      bar('2026-04-02', 10.5, 11, 10.4, 10.5), // 炸板（觸 11 收 10.5）
      bar('2026-04-03', 10.2, 10.3, 9.9, 9.97), // 次日 -5.05%
    ];
    const out = reconOne(meta, series, '2026-04-03', '2026-04-03');
    const d = out.get('2026-04-03')!;
    expect(d.yestBrokenReturns).toHaveLength(1);
    expect(d.yestBrokenReturns[0]).toBeCloseTo((9.97 / 10.5 - 1) * 100, 5);
    expect(d.yestLimitUpReturns).toHaveLength(0);
  });
});

describe('reconstructPools — ST 與板別幅度', () => {
  it('主板 ST → 5% 精確封板（4.00 → 4.20）；isST=true 且不進 yestReturns', () => {
    const meta: BackfillSymbolMeta = { symbol: '600200.SS', name: '*ST华微', industry: null };
    const series = [
      bar('2026-04-01', 4, 4.05, 3.95, 4),
      bar('2026-04-02', 4.1, 4.2, 4.08, 4.2),   // 5% 封板
      bar('2026-04-03', 4.3, 4.41, 4.25, 4.41), // 再封（次日報酬不得進 yestLimitUpReturns）
    ];
    const out = reconOne(meta, series, '2026-04-02', '2026-04-03');
    const d2 = out.get('2026-04-02')!;
    expect(d2.limitUp).toHaveLength(1);
    expect(d2.limitUp[0]).toMatchObject({ isST: true, consecBoards: 1 });
    // 10% 規則下 4.2 只是 +5% 不會被收 → 證明走的是 5% 幅度
    expect(out.get('2026-04-03')!.limitUp[0].consecBoards).toBe(2);
    expect(out.get('2026-04-03')!.yestLimitUpReturns).toHaveLength(0); // ST 排除
  });

  it('創業板 20cm（10.00 → 12.00）；ST 創業板股仍 20%（板別優先於 ST）', () => {
    const normal: BackfillSymbolMeta = { symbol: '300100.SZ', name: '双林股份', industry: '汽车零部件' };
    const stGrowth: BackfillSymbolMeta = { symbol: '300200.SZ', name: 'ST高盟', industry: null };
    const series = [
      bar('2026-04-01', 10, 10.1, 9.9, 10),
      bar('2026-04-02', 11, 12, 10.9, 12), // +20% 封板
    ];
    const out = reconstructPools({
      metas: [normal, stGrowth],
      loadSeries: () => series,
      from: '2026-04-02',
      to: '2026-04-02',
    });
    const d = out.get('2026-04-02')!;
    expect(d.limitUp).toHaveLength(2);
    expect(d.limitUp.find((e) => e.symbol === '300100')).toMatchObject({ board: 'ChiNext', isST: false });
    // ST 創業板：若誤用 5%/10% 幅度，12.00 會超過漲停價而判不出封板 → 必須仍判 20% 封板
    expect(d.limitUp.find((e) => e.symbol === '300200')).toMatchObject({ board: 'ChiNext', isST: true, consecBoards: 1 });
  });

  it('科創板 688 → STAR 20cm', () => {
    const meta: BackfillSymbolMeta = { symbol: '688100.SS', name: '威胜信息', industry: null };
    const series = [
      bar('2026-04-01', 50, 50.5, 49.5, 50),
      bar('2026-04-02', 55, 60, 54, 60), // 漲停價 round(50×1.2,2)=60.00
    ];
    const out = reconOne(meta, series, '2026-04-02', '2026-04-02');
    expect(out.get('2026-04-02')!.limitUp[0].board).toBe('STAR');
  });
});

describe('reconstructPools — 全 universe 家數統計', () => {
  it('upCount / downCount / flatCount 按 close vs prevClose 累計', () => {
    const mk = (symbol: string, c1: number, c2: number): { meta: BackfillSymbolMeta; series: BackfillSeriesBar[] } => ({
      meta: { symbol, name: symbol, industry: null },
      series: [bar('2026-04-01', c1, c1, c1, c1), bar('2026-04-02', c2, c2 + 0.01, c2 - 0.01, c2)],
    });
    const fixtures = [
      mk('600001.SS', 10, 10.5), // 漲
      mk('600002.SS', 10, 9.5),  // 跌
      mk('600003.SS', 10, 10),   // 平
      mk('000004.SZ', 10, 10.2), // 漲
    ];
    const bySymbol = new Map(fixtures.map((f) => [f.meta.symbol, f.series]));
    const out = reconstructPools({
      metas: fixtures.map((f) => f.meta),
      loadSeries: (s) => bySymbol.get(s) ?? null,
      from: '2026-04-02',
      to: '2026-04-02',
    });
    expect(out.get('2026-04-02')!.overview).toEqual({ upCount: 2, downCount: 1, flatCount: 1 });
  });

  it('loadSeries 回 null / 單根序列 → 安全跳過', () => {
    const out = reconstructPools({
      metas: [
        { symbol: '600001.SS', name: 'A', industry: null },
        { symbol: '600002.SS', name: 'B', industry: null },
      ],
      loadSeries: (s) => (s === '600001.SS' ? null : [bar('2026-04-02', 10, 10, 10, 10)]),
      from: '2026-04-01',
      to: '2026-04-03',
    });
    expect(out.size).toBe(0);
  });
});
