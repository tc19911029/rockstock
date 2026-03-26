import { Candle, CandleWithIndicators } from '@/types';
import { yahooProvider } from './YahooDataProvider';

// Re-export types so existing importers that relied on this module still compile.
export type { Candle, CandleWithIndicators };

/**
 * @deprecated Use yahooProvider.getHistoricalCandles() directly
 */
export async function fetchCandlesYahoo(
  ticker: string,
  period = '1y',
  timeoutMs = 20000,
  asOfDate?: string,
): Promise<CandleWithIndicators[]> {
  return yahooProvider.getHistoricalCandles(ticker, period, asOfDate, timeoutMs);
}

/**
 * @deprecated Use yahooProvider.getCandlesRange() directly
 */
export async function fetchCandlesRange(
  ticker: string,
  startDate: string,
  endDate: string,
  timeoutMs = 8000,
): Promise<Candle[]> {
  return yahooProvider.getCandlesRange(ticker, startDate, endDate, timeoutMs);
}
