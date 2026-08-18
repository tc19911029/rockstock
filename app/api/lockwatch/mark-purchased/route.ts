/**
 * POST /api/lockwatch/mark-purchased
 *
 * 用戶買進 LockWatch 名單中的股票（議題 62）。
 * 標 currentStage='purchased' + 紀錄 entryPrice。
 *
 * Body: { market: 'TW'|'CN', symbol: string, triggerSignal: 'F'|'N', entryPrice: number }
 */
import { NextRequest } from 'next/server';
import { apiOk, apiError } from '@/lib/api/response';
import { checkSameOriginOrCron } from '@/lib/api/sameOriginAuth';
import {
  loadLatestLockWatchSnapshot,
  loadLockWatchSnapshot,
  saveLockWatchSnapshot,
  withLockWatchLock,
} from '@/lib/storage/lockWatchStorage';
import { markLockWatchPurchased, updateLockWatch } from '@/lib/scanner/lockWatchManager';
import {
  getLockWatchPurchaseBlockReason,
  lockWatchPurchaseBlockMessage,
} from '@/lib/scanner/lockWatchEligibility';
import { normalizePatternSymbol } from '@/lib/scanner/lockedPatternSelection';
import { getLastTradingDay } from '@/lib/datasource/marketHours';
import { isTopPatternType } from '@/lib/analysis/patternCatalog';

export const runtime = 'nodejs';

interface Body {
  market?: 'TW' | 'CN';
  symbol?: string;
  triggerSignal?: 'F' | 'N';
  entryPrice?: number;
  triggeredDate?: string;
}

export async function POST(req: NextRequest) {
  const denied = checkSameOriginOrCron(req);
  if (denied) return denied;

  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return apiError('invalid JSON', 400);
  }
  const { market, symbol, triggerSignal, entryPrice, triggeredDate } = body;
  if (!market || !['TW', 'CN'].includes(market)) return apiError('market must be TW or CN', 400);
  if (!symbol) return apiError('symbol required', 400);
  if (!triggerSignal || !['F', 'N'].includes(triggerSignal)) return apiError('triggerSignal must be F or N', 400);
  if (typeof entryPrice !== 'number' || !Number.isFinite(entryPrice) || entryPrice <= 0) {
    return apiError('entryPrice required (positive finite number)', 400);
  }
  if (triggeredDate && !/^\d{4}-\d{2}-\d{2}$/.test(triggeredDate)) {
    return apiError('triggeredDate must be YYYY-MM-DD', 400);
  }

  try {
    const latest = await loadLatestLockWatchSnapshot(market);
    if (!latest) return apiError('no LockWatch snapshot', 404);

    return await withLockWatchLock(market, latest.date, async () => {
      const snapshot = await loadLockWatchSnapshot(market, latest.date);
      if (!snapshot) return apiError('LockWatch snapshot disappeared during update', 409);

      const normalizedSymbol = normalizePatternSymbol(symbol);
      const idx = snapshot.records.findIndex((r) =>
        normalizePatternSymbol(r.symbol) === normalizedSymbol &&
        r.triggerSignal === triggerSignal &&
        (!triggeredDate || r.triggeredDate === triggeredDate),
      );
      if (idx < 0) return apiError(`record not found: ${symbol} ${triggerSignal}`, 404);

      // 不信任前端 URL 帶來的舊頸線／目標。買入前以最新 K 線重跑生命週期與 detector migration。
      const scanner = market === 'TW'
        ? new (await import('@/lib/scanner/TaiwanScanner')).TaiwanScanner()
        : new (await import('@/lib/scanner/ChinaScanner')).ChinaScanner();
      const today = getLastTradingDay(market);
      const candles = await scanner.fetchCandles(snapshot.records[idx].symbol, today).catch(() => []);
      if (!candles || candles.length === 0) {
        return apiError('最新 K 線暫時無法取得，為避免使用過期型態，本次不寫入持倉。', 503);
      }

      const refreshed = updateLockWatch(snapshot.records[idx], candles, [], today).record;
      const blockReason = getLockWatchPurchaseBlockReason(refreshed, entryPrice);
      if (blockReason) {
        const newRecords = [...snapshot.records];
        newRecords[idx] = refreshed;
        await saveLockWatchSnapshot({
          ...snapshot,
          records: newRecords,
          lastUpdated: new Date().toISOString(),
        });
        return apiError(lockWatchPurchaseBlockMessage(blockReason), 409);
      }

      const updated = markLockWatchPurchased(refreshed, today, entryPrice);
      const newRecords = [...snapshot.records];
      newRecords[idx] = updated;
      await saveLockWatchSnapshot({
        ...snapshot,
        records: newRecords,
        lastUpdated: new Date().toISOString(),
      });

      const entryPattern = updated.triggerSignal === 'N' && updated.patternType && updated.patternTargetPrice
        ? {
            patternType: updated.patternType,
            necklinePrice: updated.triggerPrice,
            targetPrice: updated.patternTargetPrice,
            stopPrice: updated.structureBrokenPrice,
            kind: isTopPatternType(updated.patternType) ? 'top' as const : 'bottom' as const,
          }
        : undefined;

      return apiOk({
        market,
        symbol: updated.symbol,
        triggerSignal,
        triggeredDate: updated.triggeredDate,
        entryPrice,
        currentStage: updated.currentStage,
        entryPattern,
      });
    });
  } catch (err) {
    console.error('[lockwatch/mark-purchased] failed:', err);
    return apiError(`mark-purchased failed: ${String(err)}`);
  }
}
