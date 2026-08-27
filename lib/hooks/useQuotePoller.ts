/**
 * Shared quote polling hook — consolidates duplicate 30s polling
 * across BottomPanel and Portfolio page.
 *
 * Usage:
 *   const { prices, refresh, isRefreshing } = useQuotePoller(symbols, { intervalMs: 30_000 });
 */
import { useState, useCallback, useEffect, useMemo, useRef } from 'react';

export interface QuoteData {
  price: number;
  changePercent: number;
  loading: boolean;
  error?: string;
  asOf?: string | null;
  stale?: boolean;
  staleReason?: string;
}

interface UseQuotePollerOptions {
  /** Polling interval in ms (default 30_000) */
  intervalMs?: number;
  /** Whether polling is enabled (default true) */
  enabled?: boolean;
}

type QuoteResponse = Array<{
  symbol: string;
  price: number;
  changePercent: number;
  asOf?: string | null;
  stale?: boolean;
  staleReason?: string;
}>;
type QuoteBatchResponse = { quotes: QuoteResponse; missingSymbols: string[] };

// 同一批 symbols 共用網路請求，但每個 hook 都要拿到結果並更新自己的 state。
// 舊版共用的是「包含第一個元件 setState 的 Promise」，第二個元件雖 await 完卻收不到資料。
const inflightRequests = new Map<string, Promise<QuoteBatchResponse>>();

async function fetchQuoteBatch(symbols: string[], key: string): Promise<QuoteBatchResponse> {
  const existing = inflightRequests.get(key);
  if (existing) return existing;

  const request = fetch(`/api/portfolio/quotes?symbols=${encodeURIComponent(symbols.join(','))}`, {
    cache: 'no-store',
  })
    .then(async (res) => {
      if (!res.ok) throw new Error(`quote HTTP ${res.status}`);
      const json = await res.json();
      return {
        quotes: (json.quotes ?? []) as QuoteResponse,
        missingSymbols: Array.isArray(json.missingSymbols) ? json.missingSymbols : [],
      };
    })
    .finally(() => inflightRequests.delete(key));

  inflightRequests.set(key, request);
  return request;
}

export function useQuotePoller(
  symbols: string[],
  { intervalMs = 30_000, enabled = true }: UseQuotePollerOptions = {},
) {
  const [prices, setPrices] = useState<Record<string, QuoteData>>({});
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [updatedAt, setUpdatedAt] = useState<string | null>(null);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const symbolsKey = [...new Set(symbols.filter(Boolean))].sort().slice(0, 50).join(',');
  const normalizedSymbols = useMemo(
    () => symbolsKey ? symbolsKey.split(',') : [],
    [symbolsKey],
  );

  const refresh = useCallback(async () => {
    if (normalizedSymbols.length === 0) return;

    setIsRefreshing(true);
    try {
      const { quotes, missingSymbols } = await fetchQuoteBatch(normalizedSymbols, symbolsKey);
      const missing = new Set(missingSymbols);
      setPrices(prev => {
        const next = { ...prev };
        for (const symbol of normalizedSymbols) {
          const q = quotes.find(item => item.symbol === symbol);
          if (q && q.price > 0) {
            next[symbol] = {
              price: q.price,
              changePercent: q.changePercent,
              loading: false,
              asOf: q.asOf,
              stale: q.stale,
              staleReason: q.staleReason,
            };
          } else {
            next[symbol] = {
              ...(next[symbol] ?? { price: 0, changePercent: 0 }),
              loading: false,
              stale: true,
              error: '報價暫時缺失',
              staleReason: missing.has(symbol) ? '本輪報價來源沒有回傳此股票' : '本輪報價無有效價格',
            };
          }
        }
        return next;
      });
      setUpdatedAt(new Date().toISOString());
    } catch {
      setPrices(prev => {
        const next = { ...prev };
        for (const symbol of normalizedSymbols) {
          next[symbol] = {
            ...(next[symbol] ?? { price: 0, changePercent: 0 }),
            loading: false,
            stale: true,
            error: '更新失敗',
            staleReason: '報價 API 無法連線；顯示值是上次成功資料',
          };
        }
        return next;
      });
    } finally {
      setIsRefreshing(false);
    }
  }, [normalizedSymbols, symbolsKey]);

  // Auto-poll with visibility pause
  useEffect(() => {
    if (!enabled || !symbolsKey) return;

    const start = () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
      intervalRef.current = setInterval(refresh, intervalMs);
    };
    const stop = () => {
      if (intervalRef.current) { clearInterval(intervalRef.current); intervalRef.current = null; }
    };

    void refresh();
    start();

    const handleVisibility = () => {
      if (document.hidden) stop();
      else { refresh(); start(); }
    };
    document.addEventListener('visibilitychange', handleVisibility);

    return () => {
      stop();
      document.removeEventListener('visibilitychange', handleVisibility);
    };
  }, [refresh, intervalMs, enabled, symbolsKey]);

  return { prices, refresh, isRefreshing, updatedAt };
}
