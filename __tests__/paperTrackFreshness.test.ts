import { assessPaperTrackFreshness } from '@/lib/health/paperTrackFreshness';

describe('paper-track freshness', () => {
  const now = Date.parse('2026-08-16T04:00:00.000Z');

  it('超過三日不可再標示 live', () => {
    const result = assessPaperTrackFreshness('2026-06-12T01:45:00.475Z', now);
    expect(result.level).toBe('stale');
    expect(result.message).toContain('不能視為即時追蹤');
  });

  it('一天內更新視為正常', () => {
    expect(assessPaperTrackFreshness('2026-08-16T01:00:00.000Z', now).level).toBe('ok');
  });

  it('缺少或損壞時間明確回 missing', () => {
    expect(assessPaperTrackFreshness('', now).level).toBe('missing');
    expect(assessPaperTrackFreshness('not-a-date', now).level).toBe('missing');
  });
});
