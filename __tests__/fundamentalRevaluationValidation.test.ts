import { validateFundamentalSession } from '@/lib/strategy/fundamentalRevaluation/validation';

function session(totalCandidates: number, topCount: number, insufficientCount: number) {
  return {
    market: 'TW' as const,
    date: '2026-08-07',
    strategyVersion: 'test',
    computedAt: '2026-08-07T10:00:00Z',
    totalCandidates,
    top100: Array.from({ length: topCount }, () => ({})),
    exclusionLists: {
      oneTimeGainExcluded: [],
      deductedNetProfitPoor: [],
      valuationStretched: [],
      cyclicalPeak: [],
      insufficientData: Array.from({ length: insufficientCount }, () => ({})),
    },
  } as unknown as Parameters<typeof validateFundamentalSession>[0];
}

describe('validateFundamentalSession', () => {
  test('拒絕只有 30 檔候選的空殼結果', () => {
    expect(validateFundamentalSession(session(30, 0, 5))).toMatchObject({ valid: false });
  });

  test('拒絕 300 檔候選但完全沒有完成評估', () => {
    expect(validateFundamentalSession(session(300, 0, 0))).toMatchObject({ valid: false, evaluatedCount: 0 });
  });

  test('合理母體且過半完成評估才有效', () => {
    expect(validateFundamentalSession(session(300, 100, 80))).toMatchObject({ valid: true, evaluatedCount: 180 });
  });
});
