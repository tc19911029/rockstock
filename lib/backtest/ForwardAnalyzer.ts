import { fetchCandlesRange } from '@/lib/datasource/YahooFinanceDS';
import { StockForwardPerformance, ForwardCandle } from '@/lib/scanner/types';

const FORWARD_WINDOW_DAYS = 32; // calendar days to cover 20+ trading days
const CONCURRENCY = 10;

/**
 * Analyse forward performance for a single stock after a scan date.
 * Fetches candles from (scanDate+1) to (scanDate+21 calendar days).
 * Returns null if data unavailable.
 */
async function analyzeOne(
  symbol:    string,
  name:      string,
  scanDate:  string,
  scanPrice: number,
): Promise<StockForwardPerformance | null> {
  try {
    // Start from day after scan date
    const startMs  = Date.parse(scanDate) + 86400_000;
    const endMs    = startMs + FORWARD_WINDOW_DAYS * 86400_000;
    const startStr = new Date(startMs).toISOString().split('T')[0];
    const endStr   = new Date(endMs).toISOString().split('T')[0];

    const candles = await fetchCandlesRange(symbol, startStr, endStr, 8000);

    if (candles.length === 0) return null;

    const forwardCandles: ForwardCandle[] = candles.map(c => ({
      date:  c.date,
      open:  c.open,
      close: c.close,
      high:  c.high,
      low:   c.low,
    }));

    function ret(idx: number): number | null {
      if (idx >= forwardCandles.length) return null;
      return +((forwardCandles[idx].close - scanPrice) / scanPrice * 100).toFixed(2);
    }

    // Next trading day open return (proxy for "隔天開盤1小時後")
    const openReturn: number | null = forwardCandles.length > 0
      ? +((forwardCandles[0].open - scanPrice) / scanPrice * 100).toFixed(2)
      : null;

    // Max gain / max loss across all forward candles
    let maxGain = 0;
    let maxLoss = 0;
    for (const c of forwardCandles) {
      const highRet = (c.high  - scanPrice) / scanPrice * 100;
      const lowRet  = (c.low   - scanPrice) / scanPrice * 100;
      if (highRet > maxGain) maxGain = highRet;
      if (lowRet  < maxLoss) maxLoss = lowRet;
    }

    return {
      symbol,
      name,
      scanDate,
      scanPrice,
      openReturn,
      d1Return:  ret(0),
      d2Return:  ret(1),
      d3Return:  ret(2),
      d4Return:  ret(3),
      d5Return:  ret(4),
      d10Return: ret(9),
      d20Return: ret(19),
      maxGain:   +maxGain.toFixed(2),
      maxLoss:   +maxLoss.toFixed(2),
      forwardCandles,
    };
  } catch {
    return null;
  }
}

/**
 * Batch-analyze forward performance for a list of stocks.
 */
export async function analyzeForwardBatch(
  stocks:   Array<{ symbol: string; name: string; scanPrice: number }>,
  scanDate: string,
): Promise<StockForwardPerformance[]> {
  const results: StockForwardPerformance[] = [];

  for (let i = 0; i < stocks.length; i += CONCURRENCY) {
    const batch = stocks.slice(i, i + CONCURRENCY);
    const settled = await Promise.allSettled(
      batch.map(({ symbol, name, scanPrice }) =>
        analyzeOne(symbol, name, scanDate, scanPrice)
      )
    );
    for (const r of settled) {
      if (r.status === 'fulfilled' && r.value) results.push(r.value);
    }
  }

  return results;
}

/**
 * Calculate summary statistics over a list of forward performances.
 */
export function calcBacktestSummary(perf: StockForwardPerformance[], horizon: 'open' | 'd1' | 'd2' | 'd3' | 'd4' | 'd5' | 'd10' | 'd20') {
  const key = (horizon === 'open' ? 'openReturn' : `${horizon}Return`) as keyof StockForwardPerformance;
  const returns = perf
    .map(p => p[key] as number | null)
    .filter((r): r is number => r !== null);

  if (returns.length === 0) return null;

  const wins    = returns.filter(r => r > 0).length;
  const avg     = returns.reduce((a, b) => a + b, 0) / returns.length;
  const sorted  = [...returns].sort((a, b) => a - b);
  const median  = sorted[Math.floor(sorted.length / 2)];
  const maxGain = Math.max(...returns);
  const maxLoss = Math.min(...returns);

  return {
    count:    returns.length,
    wins,
    losses:   returns.length - wins,
    winRate:  +(wins / returns.length * 100).toFixed(1),
    avgReturn: +avg.toFixed(2),
    median:   +median.toFixed(2),
    maxGain:  +maxGain.toFixed(2),
    maxLoss:  +maxLoss.toFixed(2),
  };
}
