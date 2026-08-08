jest.mock('@/lib/datasource/DownloadVerifier', () => ({
  loadVerifyReport: jest.fn(),
}));

import { loadVerifyReport } from '@/lib/datasource/DownloadVerifier';
import { assertL1Coverage } from '@/lib/scanner/coverageGuard';

const mockedLoad = loadVerifyReport as jest.MockedFunction<typeof loadVerifyReport>;

function report(totalStocks: number, coverageRate: number) {
  return {
    market: 'TW' as const,
    date: '2026-08-07',
    generatedAt: '2026-08-07T10:00:00Z',
    health: 'good' as const,
    summary: {
      totalStocks,
      downloadSuccess: totalStocks,
      downloadFailed: 0,
      downloadSkipped: 0,
      coverageRate,
      stocksCurrent: Math.round(totalStocks * coverageRate),
      stocksWithGaps: 0,
      stocksWithRecentGaps: 0,
      stocksStale: 0,
      stocksClean: totalStocks,
      stocksReadFailed: 0,
    },
    failedSymbols: [], gapDetails: [], staleDetails: [],
  };
}

describe('assertL1Coverage', () => {
  test('拒絕 30/30 的假 100% 覆蓋率', async () => {
    mockedLoad.mockResolvedValue(report(30, 1));
    const result = await assertL1Coverage('TW', '2026-08-07');
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected coverage rejection');
    expect(result.reason).toContain('母體只有 30');
  });

  test('母體和覆蓋率都達標才放行', async () => {
    mockedLoad.mockResolvedValue(report(1900, 0.98));
    await expect(assertL1Coverage('TW', '2026-08-07')).resolves.toMatchObject({
      ok: true, totalStocks: 1900, coverageRate: 0.98,
    });
  });
});
