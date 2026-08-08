import { summarizeStrategyArtifacts } from '@/lib/health/strategyReadiness';

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
});
