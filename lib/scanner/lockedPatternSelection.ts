import type { MarketId } from './types';
import { isPatternType } from '../analysis/patternCatalog';

export interface LockwatchPatternRecordLike {
  symbol: string;
  market?: MarketId;
  triggerSignal?: string;
  patternType?: string;
  triggerPrice?: number;
  patternTargetPrice?: number;
  triggeredDate?: string;
  currentStage?: string;
}

const ACTIVE_PATTERN_STAGES = new Set([
  'observation',
  'entry-signal',
  'pending-breakout',
  'purchased',
]);

/** 比對鎖股資料時統一拿掉台／陸交易所後綴，避免 000001.SS 與 000001 比不到。 */
export function normalizePatternSymbol(symbol: string): string {
  return symbol.trim().toUpperCase().replace(/\.(TW|TWO|SS|SZ|BJ)$/i, '');
}

export function inferPatternMarket(symbol: string, hint?: MarketId): MarketId {
  if (hint) return hint;
  return /\.(SS|SZ|BJ)$/i.test(symbol) ? 'CN' : 'TW';
}

function isFinitePositive(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

/**
 * 只從有效 N 型態紀錄中選最新一筆。
 * 舊版先 find symbol，若同檔第一筆恰好是 F，後面的 N 會整筆漏掉。
 */
export function selectLatestLockedPattern<T extends LockwatchPatternRecordLike>(
  records: readonly T[],
  symbol: string,
): T | null {
  const normalized = normalizePatternSymbol(symbol);
  const candidates = records.filter(record =>
    normalizePatternSymbol(record.symbol) === normalized &&
    record.triggerSignal === 'N' &&
    record.patternType != null && isPatternType(record.patternType) &&
    isFinitePositive(record.triggerPrice) &&
    isFinitePositive(record.patternTargetPrice) &&
    (record.currentStage == null || ACTIVE_PATTERN_STAGES.has(record.currentStage)),
  );

  if (candidates.length === 0) return null;
  return [...candidates].sort((a, b) =>
    (b.triggeredDate ?? '').localeCompare(a.triggeredDate ?? ''),
  )[0];
}
