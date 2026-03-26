// lib/datasource/YahooDataProvider.ts
import { Candle, CandleWithIndicators } from '@/types';
import { computeIndicators } from '@/lib/indicators';
import { DataProvider } from './DataProvider';
import { globalCache } from './MemoryCache';

const YF_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
  'Accept': 'application/json',
};

// 歷史資料 TTL：24 小時（歷史資料不會變）
const HISTORICAL_TTL = 24 * 60 * 60 * 1000;
// 近期資料 TTL：5 分鐘（當天資料可能更新）
const RECENT_TTL = 5 * 60 * 1000;

function parseYahooCandles(json: unknown): Candle[] {
  const result = (json as { chart?: { result?: unknown[] } })?.chart?.result?.[0] as {
    timestamp?: number[];
    indicators?: { quote?: { open: number[]; high: number[]; low: number[]; close: number[]; volume: number[] }[] };
  } | undefined;
  if (!result) return [];

  const timestamps: number[] = result.timestamp ?? [];
  const q = result.indicators?.quote?.[0];
  if (!q) return [];

  return timestamps
    .map((ts, i) => {
      const o = q.open[i]; const h = q.high[i];
      const l = q.low[i];  const c = q.close[i];
      const v = q.volume[i];
      if (o == null || h == null || l == null || c == null || isNaN(o)) return null;
      return {
        date:   new Date(ts * 1000).toISOString().split('T')[0],
        open:   +o.toFixed(2), high: +h.toFixed(2),
        low:    +l.toFixed(2), close: +c.toFixed(2),
        volume: v ?? 0,
      };
    })
    .filter((c): c is Candle => c != null);
}

/**
 * Yahoo Finance 資料提供者
 *
 * 實作 DataProvider 介面，包含：
 * - 自動快取（歷史資料 24h，近期資料 5min）
 * - asOfDate 嚴格防止未來資料洩漏
 * - 錯誤處理與 timeout
 */
export class YahooDataProvider implements DataProvider {
  readonly name = 'Yahoo Finance';

  async getHistoricalCandles(
    symbol: string,
    period = '1y',
    asOfDate?: string,
    timeoutMs = 20000,
  ): Promise<CandleWithIndicators[]> {
    // 判斷是否為歷史資料（可以用更長的快取）
    const today = new Date().toISOString().split('T')[0];
    const isHistorical = asOfDate && asOfDate < today;
    const ttl = isHistorical ? HISTORICAL_TTL : RECENT_TTL;

    const cacheKey = `yahoo:candles:${symbol}:${period}:${asOfDate ?? 'live'}`;
    const cached = globalCache.get<CandleWithIndicators[]>(cacheKey);
    if (cached) return cached;

    let url: string;
    if (asOfDate) {
      const endUnix   = Math.floor(new Date(asOfDate).getTime() / 1000) + 2 * 86400;
      const startUnix = endUnix - 400 * 86400;
      url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&period1=${startUnix}&period2=${endUnix}&includePrePost=false`;
    } else {
      url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=${period}&includePrePost=false`;
    }

    const res = await fetch(url, { headers: YF_HEADERS, signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) throw new Error(`Yahoo Finance ${res.status} for ${symbol}`);

    const rawCandles = parseYahooCandles(await res.json());
    const filtered = asOfDate
      ? rawCandles.filter(c => c.date <= asOfDate)
      : rawCandles;

    const result = computeIndicators(filtered);
    globalCache.set(cacheKey, result, ttl);
    return result;
  }

  async getCandlesRange(
    symbol: string,
    startDate: string,
    endDate: string,
    timeoutMs = 8000,
  ): Promise<Candle[]> {
    const cacheKey = `yahoo:range:${symbol}:${startDate}:${endDate}`;
    const cached = globalCache.get<Candle[]>(cacheKey);
    if (cached) return cached;

    const startUnix = Math.floor(new Date(startDate).getTime() / 1000);
    const endUnix   = Math.floor(new Date(endDate).getTime()   / 1000) + 86400;

    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&period1=${startUnix}&period2=${endUnix}&includePrePost=false`;

    const res = await fetch(url, { headers: YF_HEADERS, signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) throw new Error(`Yahoo Finance ${res.status} for ${symbol}`);

    const result = parseYahooCandles(await res.json());
    // 歷史區間資料可以長時間快取
    globalCache.set(cacheKey, result, HISTORICAL_TTL);
    return result;
  }
}

/** 全域 Yahoo provider 單例 */
export const yahooProvider = new YahooDataProvider();
