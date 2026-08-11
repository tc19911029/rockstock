import { parseTwseCompanyFinancials } from '@/lib/datasource/TwseCompanyFinancials';

describe('TWSE company financial history parser', () => {
  const payload = {
    info: { status: 'success' },
    chart: {
      eps: {
        categories: ['2025Q3', '2025Q4', '2026Q1', '2026Q2'],
        series: [{ name: 'EPS', data: [6.47, 8.65, 12.28, 11.61] }],
      },
      profit: {
        categories: ['2025Q3', '2025Q4', '2026Q1', '2026Q2'],
        series: [
          { name: '毛利率', data: [24.22, 19.04, 27.2, 21.55] },
          { name: '稅後純益率', data: [10.06, 9.35, 14.38, 11.19] },
        ],
      },
      revenue: {
        categories: [
          '202507', '202508', '202509',
          '202510', '202511', '202512',
          '202601', '202602', '202603',
          '202604', '202605', '202606',
        ],
        series: [{
          name: '月營收',
          data: [
            2_232_812_000, 2_767_549_000, 3_612_747_000,
            3_715_719_000, 3_936_093_000, 4_747_837_000,
            4_235_842_000, 3_351_500_000, 3_860_470_000,
            4_294_033_000, 4_674_012_000, 4_928_512_000,
          ],
        }],
      },
    },
  };

  it('normalizes official quarterly EPS and derives complete quarterly accounting rows', () => {
    const result = parseTwseCompanyFinancials(payload, 'https://twse.test/3443');
    expect(result).not.toBeNull();
    expect(result!.sourceUrl).toBe('https://twse.test/3443');
    expect(result!.quarterly.map(row => row.quarter)).toEqual([
      '2026-06-30',
      '2026-03-31',
      '2025-12-31',
      '2025-09-30',
    ]);
    expect(result!.quarterly.map(row => row.eps)).toEqual([11.61, 12.28, 8.65, 6.47]);
    expect(result!.quarterly[0].revenue).toBe(13_896_557_000);
    expect(result!.quarterly[0].netMargin).toBeCloseTo(0.1119, 6);
    expect(result!.quarterly[0].netIncome).toBeCloseTo(13_896_557_000 * 0.1119, 0);
    expect(result!.quarterly[0].grossProfit).toBeCloseTo(13_896_557_000 * 0.2155, 0);
  });

  it('keeps EPS but leaves accounting values null when a quarter lacks all three months', () => {
    const partial = structuredClone(payload);
    partial.chart.revenue.categories.shift();
    partial.chart.revenue.series[0].data.shift();
    const result = parseTwseCompanyFinancials(partial)!;
    expect(result.quarterly.at(-1)?.eps).toBe(6.47);
    expect(result.quarterly.at(-1)?.revenue).toBeNull();
    expect(result.quarterly.at(-1)?.netIncome).toBeNull();
  });

  it('rejects error and incomplete response shapes', () => {
    expect(parseTwseCompanyFinancials({ info: { status: 'error' } })).toBeNull();
    expect(parseTwseCompanyFinancials({
      info: { status: 'success' },
      chart: { eps: { categories: ['2026Q2'], series: [{ data: [11.61] }] } },
    })).toBeNull();
  });
});
