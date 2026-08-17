import { loadStrategyReadiness, summarizeStrategyArtifacts } from '@/lib/health/strategyReadiness';

jest.mock('@/lib/storage/scanStorage', () => ({
  loadPostCloseScanSession: jest.fn(async () => ({ resultCount: 0 })),
}));
jest.mock('@/lib/cn-sanse/scanStorage', () => ({
  loadSanSeScan: jest.fn(async () => ({ evaluated: 1 })),
}));

describe('strategy readiness summary', () => {
  test('缺檔與無效檔分開列出，任一存在即 partial', () => {
    expect(summarizeStrategyArtifacts('2026-08-07', [
      { key: 'A', ready: true },
      { key: 'B', ready: false, reason: 'missing' },
      { key: 'V', ready: false, reason: 'evaluated=0' },
    ])).toMatchObject({
      status: 'partial', readyCount: 1, requiredCount: 3,
      missing: ['B'], invalid: ['V'],
    });
  });

  test('unsupported artifact 保留顯示但不納入 readiness 分母', () => {
    expect(summarizeStrategyArtifacts('2026-08-07', [
      { key: 'A', ready: true },
      { key: 'V', ready: false, required: false, reason: 'unsupported' },
    ])).toMatchObject({
      status: 'ready', readyCount: 1, requiredCount: 1,
      missing: [], invalid: [],
    });
  });

  test('readiness 只檢查目前啟用策略的掃描產物', async () => {
    const { loadPostCloseScanSession } = jest.requireMock('@/lib/storage/scanStorage') as {
      loadPostCloseScanSession: jest.Mock;
    };
    loadPostCloseScanSession.mockClear();

    const readiness = await loadStrategyReadiness('CN', '2026-08-17', 'custom-growth-v2');

    expect(readiness.strategyId).toBe('custom-growth-v2');
    expect(loadPostCloseScanSession).toHaveBeenCalled();
    for (const call of loadPostCloseScanSession.mock.calls) {
      expect(call[4]).toBe('custom-growth-v2');
    }
  });
});
