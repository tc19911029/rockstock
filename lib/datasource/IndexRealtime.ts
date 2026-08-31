import type { Candle } from '@/types';
import { fetchQuote } from '@/lib/cn-sanse/cnQuote';
import { readIntradaySnapshot } from './IntradayCache';
import { assessIntradayFreshness } from './intradayFreshness';
import { isCNMarketLunchBreak } from './marketHours';

export type LiveIndexSymbol = '^TWII' | '^TWOII' | '000001.SS' | '000300.SS';

export interface LiveIndexQuote extends Candle {
  source: 'fugle' | 'mis' | 'tencent' | 'l2';
  updatedAt?: string;
}

function asCandle(quote: { open: number; high: number; low: number; close: number; volume: number }, date: string): Candle {
  const close = quote.close;
  return {
    date,
    open: quote.open > 0 ? quote.open : close,
    high: quote.high > 0 ? quote.high : close,
    low: quote.low > 0 ? quote.low : close,
    close,
    volume: quote.volume > 0 ? quote.volume : 0,
  };
}

/**
 * TW 指數與個股一樣只讀每分鐘中央 L2；指數 channel 已併入第一批股票 MIS，
 * 不額外增加 API 呼叫。CN 指數仍以騰訊單檔為主，再退中央 L2。
 */
export async function fetchLiveIndexQuote(symbol: LiveIndexSymbol, today: string): Promise<LiveIndexQuote | null> {
  const market: 'TW' | 'CN' = symbol.startsWith('^') ? 'TW' : 'CN';

  if (market === 'TW') {
    const snapshot = await readIntradaySnapshot('TW', today).catch(() => null);
    if (!snapshot || assessIntradayFreshness('TW', snapshot).stale) return null;
    const quote = snapshot.quotes.find(item => item.symbol === symbol);
    return quote && quote.close > 0
      ? { ...asCandle(quote, snapshot.date), source: 'l2', updatedAt: quote.observedAt ?? snapshot.updatedAt }
      : null;
  } else if (!isCNMarketLunchBreak()) {
    const tencent = await fetchQuote(symbol);
    if (tencent && tencent.price > 0 && tencent.date === today) {
      return {
        ...asCandle({
          open: tencent.open,
          high: tencent.high,
          low: tencent.low,
          close: tencent.price,
          volume: tencent.volumeLots * 100,
        }, today),
        source: 'tencent',
        updatedAt: tencent.updatedAt,
      };
    }
  }

  const snapshot = await readIntradaySnapshot(market, today).catch(() => null);
  if (!snapshot) return null;
  const freshness = assessIntradayFreshness(market, snapshot);
  if (freshness.stale) return null;
  const quote = snapshot.quotes.find((item) => item.symbol === symbol);
  if (!quote || quote.close <= 0) return null;
  return { ...asCandle(quote, snapshot.date), source: 'l2', updatedAt: snapshot.updatedAt };
}
