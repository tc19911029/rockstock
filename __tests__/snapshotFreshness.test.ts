import { isSnapshotTooOldForSeal } from '@/lib/datasource/snapshotFreshness';

describe('snapshot seal freshness policy', () => {
  const now = new Date('2026-08-11T01:00:00+08:00');

  it('rejects a stale same-day snapshot', () => {
    expect(isSnapshotTooOldForSeal('CN', '2026-08-11', '2026-08-10T16:00:00.000Z', now)).toBe(true);
  });

  it('allows a prior closed-day snapshot for manual recovery', () => {
    expect(isSnapshotTooOldForSeal('CN', '2026-08-10', '2026-08-10T07:28:31.765Z', now)).toBe(false);
  });

  it('rejects snapshots without a trustworthy timestamp', () => {
    expect(isSnapshotTooOldForSeal('TW', '2026-08-10', undefined, now)).toBe(true);
  });
});
