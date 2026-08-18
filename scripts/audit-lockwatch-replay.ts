/**
 * Read-only LockWatch detector migration audit.
 *
 * Usage: npx tsx scripts/audit-lockwatch-replay.ts [TW|CN] [asOfDate]
 */
import { loadLatestLockWatchSnapshot } from '@/lib/storage/lockWatchStorage';
import { loadLocalCandlesWithTolerance } from '@/lib/datasource/LocalCandleStore';
import {
  replayLockWatchNPattern,
  updateLockWatch,
} from '@/lib/scanner/lockWatchManager';
import { CURRENT_N_PATTERN_DETECTOR_VERSION } from '@/lib/scanner/lockWatchEligibility';
import type { LockWatchRecord } from '@/lib/scanner/lockWatchTypes';

const ACTIVE_STAGES = new Set<LockWatchRecord['currentStage']>([
  'observation',
  'entry-signal',
  'pending-breakout',
]);

async function main(): Promise<void> {
  const market = (process.argv[2] ?? 'TW') as 'TW' | 'CN';
  if (market !== 'TW' && market !== 'CN') throw new Error('market must be TW or CN');
  const snapshot = await loadLatestLockWatchSnapshot(market);
  if (!snapshot) throw new Error(`no ${market} LockWatch snapshot`);
  const asOfDate = process.argv[3] ?? snapshot.date;

  const counts = {
    total: snapshot.records.length,
    activeN: 0,
    currentVersion: 0,
    verified: 0,
    rejected: 0,
    unavailable: 0,
    afterActionable: 0,
    afterRevoked: 0,
    afterTargetReached: 0,
    afterStructureBroken: 0,
  };
  const rejectedReasons: Record<string, number> = {};
  const rejectedSymbols: string[] = [];

  for (const record of snapshot.records) {
    if (record.triggerSignal !== 'N' || !ACTIVE_STAGES.has(record.currentStage)) continue;
    counts.activeN++;
    if (record.detectorVersion === CURRENT_N_PATTERN_DETECTOR_VERSION) counts.currentVersion++;
    const loaded = await loadLocalCandlesWithTolerance(record.symbol, market, asOfDate, 5).catch(() => null);
    const candles = loaded?.candles ?? [];
    const replay = replayLockWatchNPattern(record, candles);
    if (replay.assessment.status === 'verified') counts.verified++;
    else if (replay.assessment.status === 'rejected') {
      counts.rejected++;
      rejectedReasons[replay.assessment.reason] = (rejectedReasons[replay.assessment.reason] ?? 0) + 1;
      rejectedSymbols.push(record.symbol);
    } else counts.unavailable++;

    const updated = updateLockWatch(record, candles, [], asOfDate).record;
    if (ACTIVE_STAGES.has(updated.currentStage)) counts.afterActionable++;
    else if (updated.currentStage === 'revoked') counts.afterRevoked++;
    else if (updated.currentStage === 'target-reached') counts.afterTargetReached++;
    else if (updated.currentStage === 'structure-broken') counts.afterStructureBroken++;
  }

  console.log(JSON.stringify({
    market,
    snapshotDate: snapshot.date,
    asOfDate,
    detectorVersion: CURRENT_N_PATTERN_DETECTOR_VERSION,
    counts,
    rejectedReasons,
    rejectedSymbols,
  }, null, 2));
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
