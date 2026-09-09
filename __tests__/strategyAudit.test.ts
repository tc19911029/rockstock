import { collectStrategyGaps, repairEndpoint, scanArtifactReason } from '@/lib/health/strategyAudit';
import { summarizeStrategyArtifacts } from '@/lib/health/strategyReadiness';

test('完整零結果有效，缺池、資料不足、錯誤筆數及價格不可冒充成功', () => {
  expect(scanArtifactReason({ results: [], resultCount: 0 })).toBeUndefined();
  expect(scanArtifactReason(null)).toBe('missing');
  expect(scanArtifactReason({ results: [], resultCount: 1 })).toBe('result-count-mismatch');
  expect(scanArtifactReason({ results: [], resultCount: 0, step1Filter: 'missing' })).toBe('step1-pool-missing');
  expect(scanArtifactReason({ results: [], resultCount: 0, dataFreshness: { dataStatus: 'insufficient' } })).toBe('insufficient-input');
  expect(scanArtifactReason({ results: [{ symbol: 'A', price: NaN }], resultCount: 1 })).toBe('invalid-price-or-symbol');
  expect(scanArtifactReason({ results: [{ symbol: 'A', price: 1 }, { symbol: 'A', price: 1 }], resultCount: 2 })).toBe('duplicate-symbol');
});

test('中斷留下的缺口下次會再排入；已修好或不支援的產物不列漏檔', () => {
  const days = [summarizeStrategyArtifacts('2026-09-08', [
    { key: 'SanSe', ready: false, reason: 'wrong-date' },
    { key: 'A', ready: true }, { key: 'V', ready: false, required: false },
  ])];
  const gaps = collectStrategyGaps(days, [{ date: '2026-09-08', key: 'SanSe', reason: 'missing', attempts: 2, state: 'running' }]);
  expect(gaps).toHaveLength(1);
  expect(gaps[0]).toMatchObject({ attempts: 2, state: 'pending', detail: expect.stringContaining('interrupted') });
});

test('基本面與未驗證歷史重播不得自動套用最新資料；三色保留目標日', () => {
  const gap = { date: '2026-09-07', key: 'SanSe', reason: 'missing', attempts: 0, state: 'pending' as const };
  expect(repairEndpoint('TW', gap, '2026-09-08')).toContain('date=2026-09-07');
  expect(repairEndpoint('TW', { ...gap, key: 'V' }, '2026-09-08')).toBeNull();
  expect(repairEndpoint('TW', { ...gap, key: 'A30' }, '2026-09-08')).toBeNull();
  expect(repairEndpoint('TW', { ...gap, key: 'B' }, '2026-09-08')).toBeNull();
  expect(repairEndpoint('TW', { ...gap, key: 'B', date: '2026-09-08' }, '2026-09-08')).toContain('track=bullish');
});

test('已封存的空 Step 1 池是正常套用，只有池不存在才 missing', async () => {
  const { deriveStep1FilterState } = await import('@/lib/scanner/step1Pool');
  expect(deriveStep1FilterState('B', true)).toBe('applied');
  expect(deriveStep1FilterState('B', false)).toBe('missing');
});
