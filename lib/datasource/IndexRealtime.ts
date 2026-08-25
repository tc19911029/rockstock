import type { Candle } from '@/types';
import { fetchQuote } from '@/lib/cn-sanse/cnQuote';
import { getFugleQuote, isFugleAvailable } from './FugleProvider';
import { fetchTWIndexQuote, readIntradaySnapshot } from './IntradayCache';
import { assessIntradayFreshness } from './intradayFreshness';

export type LiveIndexSymbol = '^TWII' | '^TWOII' | '000001.SS' | '000300.SS';

export interface LiveIndexQuote extends Candle {
  source: 'fugle' | 'mis' | 'tencent' | 'l2';
  updatedAt?: string;
}

const FUGLE_INDEX_SYMBOLS: Record<'^TWII' | '^TWOII', string> = {
  '^TWII': 'IX0001',
  '^TWOII': 'IX0043',
};

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
 * 大盤獨立即時鏈：不再先吃 5 分鐘全市場 L2。
 *
 * TW 指數優先 Fugle（5 秒快取）再退 MIS；CN 指數直接走騰訊單檔。
 * 兩條獨立來源都失敗時，才允許使用通過新鮮度檢查的 L2，避免把凍結快照
 * 每 30 秒重新包裝成「即時」回給前端。
 */
export async function fetchLiveIndexQuote(symbol: LiveIndexSymbol, today: string): Promise<LiveIndexQuote | null> {
  const market: 'TW' | 'CN' = symbol.startsWith('^') ? 'TW' : 'CN';

  if (market === 'TW') {
    if (isFugleAvailable()) {
      const fugle = await getFugleQuote(FUGLE_INDEX_SYMBOLS[symbol as '^TWII' | '^TWOII']);
      if (fugle && fugle.close > 0 && fugle.date === today) {
        return { ...asCandle(fugle, today), source: 'fugle', updatedAt: fugle.updatedAt };
      }
    }

    const mis = await fetchTWIndexQuote(today, symbol as '^TWII' | '^TWOII');
    if (mis && mis.close > 0) {
      return { ...asCandle(mis, today), source: 'mis' };
    }
  } else {
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
  if (!quote || quote.close <= 0 || (market === 'TW' && quote.isActualTrade === false)) return null;
  return { ...asCandle(quote, snapshot.date), source: 'l2', updatedAt: snapshot.updatedAt };
}
