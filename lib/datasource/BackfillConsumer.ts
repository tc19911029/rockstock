import { dataProvider } from './MultiMarketProvider';
import { loadBackfillQueue, markAttempt, MAX_ATTEMPTS, removeFromQueue, saveBackfillQueue } from './BackfillQueue';
import type { BackfillRange } from './BackfillQueue';
import { readCandleFile } from './CandleStorageAdapter';
import { saveLocalCandles } from './LocalCandleStore';
import { detectCandleGaps, type CandleGap } from './validateCandles';

export interface BackfillConsumeResult {
  actionable: number;
  filled: number;
  failed: number;
  skipped: number;
  abandoned: number;
}

/** Keep queue ranges that still overlap a verifier-detectable gap after merge. */
export function unresolvedBackfillRanges(
  ranges: readonly BackfillRange[],
  gaps: readonly CandleGap[],
): BackfillRange[] {
  return ranges.filter(range => gaps.some(gap => gap.fromDate < range.to && gap.toDate > range.from));
}

/**
 * Consume historical L1 gaps and verify the merged file before acknowledging.
 * This is shared by the HTTP downloader and the local eod-settle pipeline.
 */
export async function consumeBackfillQueue(
  market: 'TW' | 'CN',
  options: { budgetMs?: number } = {},
): Promise<BackfillConsumeResult> {
  const startedAt = Date.now();
  const budgetMs = options.budgetMs ?? 30_000;
  const queue = await loadBackfillQueue(market);
  const actionable = queue.items.filter(item => item.attempts < MAX_ATTEMPTS);
  const result: BackfillConsumeResult = {
    actionable: actionable.length,
    filled: 0,
    failed: 0,
    skipped: 0,
    abandoned: queue.items.filter(item => item.attempts >= MAX_ATTEMPTS).length,
  };

  for (let index = 0; index < actionable.length; index++) {
    const item = actionable[index];
    if (Date.now() - startedAt > budgetMs) {
      result.skipped = actionable.length - index;
      break;
    }

    try {
      if (item.ranges.length === 0) {
        removeFromQueue(queue, item.symbol);
        result.filled++;
        await saveBackfillQueue(queue);
        continue;
      }
      const earliest = item.ranges.reduce((value, range) => range.from < value ? range.from : value, item.ranges[0].from);
      const latest = item.ranges.reduce((value, range) => range.to > value ? range.to : value, item.ranges[0].to);
      const candles = await dataProvider.getCandlesRange(item.symbol, earliest, latest);
      if (candles.length > 0) await saveLocalCandles(item.symbol, market, candles);

      const merged = await readCandleFile(item.symbol, market);
      const gaps = merged ? detectCandleGaps(merged.candles, 10, market) : [];
      const unresolved = unresolvedBackfillRanges(item.ranges, gaps);
      if (candles.length > 0 && unresolved.length === 0) {
        removeFromQueue(queue, item.symbol);
        result.filled++;
      } else {
        item.ranges = unresolved.length > 0 ? unresolved : item.ranges;
        markAttempt(
          queue,
          item.symbol,
          candles.length === 0 ? 'provider returned empty' : 'requested gap remains after merge',
        );
        result.failed++;
      }
    } catch (error) {
      markAttempt(queue, item.symbol, error instanceof Error ? error.message : String(error));
      result.failed++;
    }

    // Persist every acknowledgement/attempt so a later crash cannot reset the
    // queue to attempts=0 or resurrect already repaired symbols.
    await saveBackfillQueue(queue);
  }

  result.abandoned = queue.items.filter(item => item.attempts >= MAX_ATTEMPTS).length;
  return result;
}
