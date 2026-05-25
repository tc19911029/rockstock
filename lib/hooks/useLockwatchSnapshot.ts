'use client';

import { useCallback, useEffect, useState } from 'react';
import type { LockWatchDailySnapshot } from '@/lib/scanner/lockWatchTypes';

interface ApiResponse {
  ok: boolean;
  snapshot: LockWatchDailySnapshot | null;
  dates?: string[];
  error?: string;
}

// ── 跨組件共用 in-flight promise + short-TTL cache ──
// 多個組件同時 mount 都 call 這個 hook 時（如 LockWatchPanel + ScanResultsCompact），
// 不要各自 fetch，共用同一個 promise。網路面板從 4-6 次 → 1 次。
const inflight = new Map<string, Promise<ApiResponse>>();
const cache = new Map<string, { data: ApiResponse; expiresAt: number }>();
const CACHE_TTL_MS = 3000; // 3 秒，足夠多組件 mount 共用、不影響重整新鮮度

function sharedFetch(market: 'TW' | 'CN'): Promise<ApiResponse> {
  const cached = cache.get(market);
  if (cached && cached.expiresAt > Date.now()) return Promise.resolve(cached.data);
  const existing = inflight.get(market);
  if (existing) return existing;
  const p = fetch(`/api/lockwatch?market=${market}`)
    .then(r => r.json() as Promise<ApiResponse>)
    .then(json => {
      cache.set(market, { data: json, expiresAt: Date.now() + CACHE_TTL_MS });
      inflight.delete(market);
      return json;
    })
    .catch(err => {
      inflight.delete(market);
      throw err;
    });
  inflight.set(market, p);
  return p;
}

/**
 * 共用 lockwatch snapshot fetch（LockWatchPanel + ScanResultsCompact）。
 * 回傳 reload 讓呼叫端在 user 操作（如手動移除一檔）後重新拉取。
 */
export function useLockwatchSnapshot(market: 'TW' | 'CN' | null | undefined): {
  snapshot: LockWatchDailySnapshot | null;
  loading: boolean;
  error: string | null;
  reload: () => Promise<void>;
} {
  const [snapshot, setSnapshot] = useState<LockWatchDailySnapshot | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchData = useCallback(async (bustCache = false) => {
    if (!market) return;
    if (bustCache) cache.delete(market);
    setLoading(true);
    setError(null);
    try {
      const json = await sharedFetch(market);
      if (!json.ok) {
        setError(json.error ?? 'load failed');
        return;
      }
      setSnapshot(json.snapshot);
    } catch (err) {
      setError(String(err));
    } finally {
      setLoading(false);
    }
  }, [market]);

  useEffect(() => {
    void fetchData();
  }, [fetchData]);

  // reload bypasses cache（user 主動觸發 → 一定要拿新鮮）
  const reload = useCallback(() => fetchData(true), [fetchData]);
  return { snapshot, loading, error, reload };
}
