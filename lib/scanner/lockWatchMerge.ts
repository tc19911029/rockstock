import type { LockWatchEvent, LockWatchRecord } from './lockWatchTypes';

const TERMINAL_STAGES = new Set<LockWatchRecord['currentStage']>([
  'purchased',
  'revoked',
  'manually-removed',
  'structure-broken',
  'target-reached',
]);

function mergeHistory(older: readonly LockWatchEvent[], newer: readonly LockWatchEvent[]): LockWatchEvent[] {
  const seen = new Set<string>();
  const result: LockWatchEvent[] = [];
  for (const event of [...older, ...newer]) {
    const key = `${event.date}|${event.event}|${event.detail ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(event);
  }
  return result;
}

/**
 * 同一 symbol/signal 合併規則：
 * - 較新的 triggeredDate 一定勝出，避免昨日舊鎖定蓋掉今日真觸發。
 * - 同一觸發日若既有紀錄已結束（尤其 purchased），不可被重複掃描重設為 observation。
 * - 其餘同日重掃採 incoming 最新價位，但保留完整歷史。
 */
export function mergeLockWatchRecord(
  existing: LockWatchRecord,
  incoming: LockWatchRecord,
): LockWatchRecord {
  if (incoming.triggeredDate > existing.triggeredDate) {
    return { ...incoming, history: mergeHistory(existing.history, incoming.history) };
  }
  if (incoming.triggeredDate < existing.triggeredDate) return existing;
  if (TERMINAL_STAGES.has(existing.currentStage)) return existing;
  return { ...incoming, history: mergeHistory(existing.history, incoming.history) };
}
