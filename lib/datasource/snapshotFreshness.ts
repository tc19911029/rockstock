const SNAPSHOT_MAX_AGE_MS = 20 * 60_000;

/**
 * Same-day L2 snapshots must be fresh because an old file may be a pre-open
 * auction snapshot. A snapshot for an already-closed prior date may be used
 * for manual recovery; its OHLC flat-bar fingerprint is validated separately.
 */
export function isSnapshotTooOldForSeal(
  market: 'TW' | 'CN',
  snapshotDate: string,
  updatedAt: string | undefined,
  now = new Date(),
): boolean {
  if (!updatedAt) return true;
  const updatedTime = new Date(updatedAt).getTime();
  if (!Number.isFinite(updatedTime)) return true;

  const timezone = market === 'TW' ? 'Asia/Taipei' : 'Asia/Shanghai';
  const localToday = new Intl.DateTimeFormat('en-CA', { timeZone: timezone }).format(now);
  if (snapshotDate < localToday) return false;

  return now.getTime() - updatedTime > SNAPSHOT_MAX_AGE_MS;
}
