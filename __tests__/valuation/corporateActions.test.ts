import { dilutionEventSignature } from '@/lib/valuation/corporateActions';
import { mergeQuarterlyActuals, mergeSelfReportedActuals } from '@/lib/valuation/supplementalFundamentals';

describe('valuation supplemental fundamentals', () => {
  it('lets a newer official supplement replace the same quarter without duplicating it', () => {
    const merged = mergeQuarterlyActuals(
      [{ quarter: '2026-06-30', eps: null }, { quarter: '2026-03-31', eps: 3.36 }],
      [{
        quarter: '2026-06-30', revenue: 17_291_000_000, grossProfit: 4_889_000_000,
        netIncome: 3_291_000_000, nonRecurringNetIncome: 3_291_000_000, eps: 0.76,
        netMargin: 0.19033, grossMargin: 0.28275, announcedAt: '2026-07-14', sourceUrl: 'official',
      }],
    );

    expect(merged).toHaveLength(2);
    expect(merged[0]).toMatchObject({ quarter: '2026-06-30', eps: 0.76 });
  });

  it('keeps archived self-reported EPS when the rolling news feed becomes empty', () => {
    const archived = {
      period: '2026-07', revenue: 6_785_000_000, pretaxIncome: 4_255_000_000,
      netIncome: 3_490_000_000, eps: 11.61, announcedAt: '2026-08-07', sourceUrl: 'official',
      source: 'yahoo_tw_mops_republication' as const, audited: false as const, note: 'archived',
    };
    expect(mergeSelfReportedActuals([], [archived])).toEqual([archived]);
  });

  it('builds a stable dilution signature independent of input order', () => {
    const a = { type: 'gdr' as const, newShares: 420_000_000, status: 'completed' as const, announcedAt: '2026-06-22' };
    const b = { type: 'convertible_bond' as const, newShares: 1_000, status: 'pending' as const };
    expect(dilutionEventSignature([a, b])).toBe(dilutionEventSignature([b, a]));
  });
});
