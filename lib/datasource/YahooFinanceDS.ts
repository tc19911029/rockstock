import { Candle } from '@/types';
import { computeIndicators } from '@/lib/indicators';
import { CandleWithIndicators } from '@/types';

const YF_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
  'Accept': 'application/json',
};

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
 * Fetch daily candles for a symbol from Yahoo Finance.
 * @param asOfDate  YYYY-MM-DD – if provided, data is limited to that date (backtest mode).
 *                  The function fetches ~13 months ending on asOfDate so the rule engine
 *                  has enough lookback, and strips any candles dated after asOfDate.
 */
export async function fetchCandlesYahoo(
  ticker: string,
  period = '1y',
  timeoutMs = 20000,
  asOfDate?: string,
): Promise<CandleWithIndicators[]> {
  let url: string;

  if (asOfDate) {
    // period1/period2 for historical slice (no future data contamination)
    const endUnix   = Math.floor(new Date(asOfDate).getTime() / 1000) + 2 * 86400; // +2 day buffer
    const startUnix = endUnix - 400 * 86400; // ~13 months lookback
    url = [
      `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}`,
      `?interval=1d&period1=${startUnix}&period2=${endUnix}&includePrePost=false`,
    ].join('');
  } else {
    url = [
      `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}`,
      `?interval=1d&range=${period}&includePrePost=false`,
    ].join('');
  }

  const res = await fetch(url, { headers: YF_HEADERS, signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`Yahoo Finance ${res.status} for ${ticker}`);

  const rawCandles = parseYahooCandles(await res.json());

  // Hard-filter: remove any candles after asOfDate to prevent future data leakage
  const filtered = asOfDate
    ? rawCandles.filter(c => c.date <= asOfDate)
    : rawCandles;

  return computeIndicators(filtered);
}

/**
 * Fetch raw daily candles within a specific date range (used for forward performance).
 * Returns plain Candle[] without indicators.
 */
export async function fetchCandlesRange(
  ticker: string,
  startDate: string, // YYYY-MM-DD (inclusive)
  endDate:   string, // YYYY-MM-DD (inclusive)
  timeoutMs  = 8000,
): Promise<Candle[]> {
  const startUnix = Math.floor(new Date(startDate).getTime() / 1000);
  const endUnix   = Math.floor(new Date(endDate).getTime()   / 1000) + 86400;

  const url = [
    `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}`,
    `?interval=1d&period1=${startUnix}&period2=${endUnix}&includePrePost=false`,
  ].join('');

  const res = await fetch(url, { headers: YF_HEADERS, signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`Yahoo Finance ${res.status} for ${ticker}`);

  return parseYahooCandles(await res.json());
}
