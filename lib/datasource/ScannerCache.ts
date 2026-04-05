/**
 * ScannerCache — 掃描專用歷史 K 線快取
 *
 * 設計原則：
 * - 歷史日期的 K 線永遠不變（2024-01-15 的 K 線永遠是那根）→ 存了就不用再打 API
 * - 當天 / 無指定日期 → 不快取（盤中數據可能還在變）
 * - 獨立於 globalCache，不搶走圖的快取空間
 * - 無容量上限（歷史數據不會無限增長，同一 asOfDate 掃完就結束）
 * - serverless 環境下 cold start 會清空，但同一次掃描內有效
 *
 * Key 格式: `${symbol}:${asOfDate}`
 * 只快取 asOfDate < today 的歷史數據
 */

import type { CandleWithIndicators } from '@/types';

const cache = new Map<string, CandleWithIndicators[]>();

let hits = 0;
let misses = 0;

function makeKey(symbol: string, asOfDate: string): string {
  return `${symbol}:${asOfDate}`;
}

function getTodayStr(): string {
  return new Date().toISOString().split('T')[0];
}

/**
 * 查詢掃描快取
 * - 只有歷史日期（asOfDate < today）才查
 * - 當天或無日期回傳 null
 */
export function getScannerCache(
  symbol: string,
  asOfDate: string | undefined,
): CandleWithIndicators[] | null {
  if (!asOfDate || asOfDate >= getTodayStr()) {
    return null;
  }
  const key = makeKey(symbol, asOfDate);
  const cached = cache.get(key);
  if (cached) {
    hits++;
    return cached;
  }
  misses++;
  return null;
}

/**
 * 寫入掃描快取
 * - 只有歷史日期（asOfDate < today）且有數據才存
 */
export function setScannerCache(
  symbol: string,
  asOfDate: string | undefined,
  candles: CandleWithIndicators[],
): void {
  if (!asOfDate || asOfDate >= getTodayStr()) return;
  if (candles.length === 0) return;
  const key = makeKey(symbol, asOfDate);
  cache.set(key, candles);
}

/** 取得快取統計（除錯用） */
export function getScannerCacheStats(): {
  size: number;
  hits: number;
  misses: number;
  hitRate: string;
} {
  const total = hits + misses;
  return {
    size: cache.size,
    hits,
    misses,
    hitRate: total > 0 ? `${((hits / total) * 100).toFixed(1)}%` : '0%',
  };
}

/** 清空快取（測試用） */
export function clearScannerCache(): void {
  cache.clear();
  hits = 0;
  misses = 0;
}
