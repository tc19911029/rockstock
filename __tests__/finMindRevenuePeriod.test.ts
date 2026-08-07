import { normalizeRevenuePeriod, type RevenueRow } from '@/lib/datasource/FinMindClient';

describe('normalizeRevenuePeriod', () => {
  it('uses revenue_year/month instead of the following-month FinMind date', () => {
    const row: RevenueRow = {
      date: '2026-07-01',
      stock_id: '3661',
      revenue: 3_572_404_000,
      revenue_year: 2026,
      revenue_month: 6,
    };

    expect(normalizeRevenuePeriod(row).date).toBe('2026-06-01');
  });

  it('keeps the source date when period fields are invalid', () => {
    const row: RevenueRow = {
      date: '2026-07-01',
      stock_id: '3661',
      revenue: 1,
      revenue_year: 0,
      revenue_month: 0,
    };

    expect(normalizeRevenuePeriod(row).date).toBe('2026-07-01');
  });
});
