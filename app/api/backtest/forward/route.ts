import { NextRequest } from 'next/server';
import { z } from 'zod';
import { analyzeForwardBatch } from '@/lib/backtest/ForwardAnalyzer';
import { apiOk, apiError, apiValidationError } from '@/lib/api/response';

const forwardSchema = z.object({
  scanDate: z.string(),
  direction: z.enum(['long', 'short']).default('long'),
  stocks:   z.array(z.object({ symbol: z.string(), name: z.string(), scanPrice: z.number() })).default([]),
});

export const runtime    = 'nodejs';
export const maxDuration = 60;

/**
 * Server-side in-memory cache（2026-05-21 加）
 *
 * 為什麼存在：
 * - 同一個歷史掃描日（如 2026-04-23）的 scan results 是靜態的（cron 跑完封存）
 * - 但 client 每次切該日期都會 POST 過來，內部會：
 *   1. 對每檔讀 L1 candle（10 檔 ~500ms）
 *   2. 不論需不需要都試圖 inject L2 today snapshot（每次重讀完整快照檔，~100ms × N）
 *   3. 部分股票若 L1 不足會 fetch FinMind → 撞 8-token rate limiter → 數秒等候
 *   4. 即便快取沒打中，連續打同樣參數也會重做 1~3
 *
 * 實測：R session 10 檔 04-23 forward 取 42 秒，5/20 取 81 秒。對使用者來說
 * 「切歷史日期載入很久」就是這個 POST 在卡。同 (scanDate, symbols) 的結果在掃
 * 描歷史的場景是不變的（沒結算後修正），cache 10 分鐘綽綽有餘。
 *
 * Key  = `${scanDate}|${sortedSymbols.join(',')}`
 * TTL  = 10 min（覆蓋使用者快速切多個歷史日期 + 反覆切回測 summary mount）
 * Cap  = 200 entries（FIFO eviction）
 *
 * Inflight singleflight：同一 key 同時間多個 request 共享同一個 analyzeForwardBatch
 * promise，避免使用者連點兩次跑兩次。
 */
interface CacheEntry {
  result: unknown;
  expiresAt: number;
}
const FORWARD_CACHE = new Map<string, CacheEntry>();
const FORWARD_INFLIGHT = new Map<string, Promise<unknown>>();
const FORWARD_CACHE_TTL_MS = 10 * 60 * 1000;
const FORWARD_CACHE_MAX = 200;

function getCacheKey(
  scanDate: string,
  direction: 'long' | 'short',
  stocks: Array<{ symbol: string; scanPrice: number }>,
): string {
  const signature = stocks
    .map((s) => `${s.symbol}:${s.scanPrice}`)
    .sort()
    .join(',');
  return `${scanDate}|${direction}|${signature}`;
}

function readCache(key: string): unknown | null {
  const entry = FORWARD_CACHE.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    FORWARD_CACHE.delete(key);
    return null;
  }
  return entry.result;
}

function writeCache(key: string, result: unknown): void {
  if (FORWARD_CACHE.size >= FORWARD_CACHE_MAX) {
    const firstKey = FORWARD_CACHE.keys().next().value;
    if (firstKey !== undefined) FORWARD_CACHE.delete(firstKey);
  }
  FORWARD_CACHE.set(key, { result, expiresAt: Date.now() + FORWARD_CACHE_TTL_MS });
}

/**
 * POST /api/backtest/forward
 * Body: {
 *   scanDate: 'YYYY-MM-DD',
 *   stocks: [{ symbol: string; name: string; scanPrice: number }]
 * }
 *
 * Returns forward performance data for each stock after the scan date.
 * Safe to call even if scan date is recent (returns partial data).
 */
export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const parsed = forwardSchema.safeParse(body);
  if (!parsed.success) {
    return apiValidationError(parsed.error);
  }
  const { scanDate, direction, stocks } = parsed.data;

  if (!scanDate || stocks.length === 0) {
    return apiOk({ performance: [] });
  }

  const cacheKey = getCacheKey(scanDate, direction, stocks);

  // 1. Cache hit → 立即回
  const cached = readCache(cacheKey);
  if (cached) {
    return apiOk(cached);
  }

  // 2. Inflight singleflight → 共享同一個正在跑的 promise
  const inflight = FORWARD_INFLIGHT.get(cacheKey);
  if (inflight) {
    try {
      const result = await inflight;
      return apiOk(result);
    } catch (err) {
      console.error('[backtest/forward] inflight error:', err);
      return apiError('回測服務暫時無法使用');
    }
  }

  // 3. Cold call → 跑 analyzeForwardBatch，存 cache
  const promise = (async () => {
    const { results: performance, nullCount, totalRequested } = await analyzeForwardBatch(stocks, scanDate, { direction });
    const result = { performance, nullCount, totalRequested };
    writeCache(cacheKey, result);
    return result;
  })();
  FORWARD_INFLIGHT.set(cacheKey, promise);

  try {
    const result = await promise;
    return apiOk(result);
  } catch (err) {
    console.error('[backtest/forward] error:', err);
    return apiError('回測服務暫時無法使用');
  } finally {
    FORWARD_INFLIGHT.delete(cacheKey);
  }
}
