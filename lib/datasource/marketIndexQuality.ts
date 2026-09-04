import type { Candle } from '@/types';

export const MARKET_INDEX_SYMBOLS = {
  TW: ['^TWII', '^TWOII'],
  CN: ['000001.SS'],
} as const satisfies Record<'TW' | 'CN', readonly string[]>;

const TRACKED_MARKET_INDEXES = new Set<string>([
  ...MARKET_INDEX_SYMBOLS.TW,
  ...MARKET_INDEX_SYMBOLS.CN,
]);

export type MarketIndexQualityLevel = 'ok' | 'critical';

export interface MarketIndexQualityItem {
  symbol: string;
  expectedDate: string;
  lastDate: string | null;
  volume: number | null;
  complete: boolean;
  reason?: 'missing-file' | 'missing-date' | 'invalid-ohlc' | 'missing-volume';
}

export interface MarketIndexQualityStatus {
  level: MarketIndexQualityLevel;
  expectedDate: string;
  indexes: MarketIndexQualityItem[];
}

export function isTrackedMarketIndex(symbol: string): boolean {
  return TRACKED_MARKET_INDEXES.has(symbol);
}

export function isCompleteMarketIndexCandle(candle: Candle | undefined): candle is Candle {
  if (!candle) return false;
  return Number.isFinite(candle.open) && candle.open > 0
    && Number.isFinite(candle.high) && candle.high > 0
    && Number.isFinite(candle.low) && candle.low > 0
    && Number.isFinite(candle.close) && candle.close > 0
    && candle.low <= candle.open && candle.open <= candle.high
    && candle.low <= candle.close && candle.close <= candle.high
    && Number.isFinite(candle.volume) && candle.volume > 0;
}

/**
 * 指數資料不可把「來源尚未公布／抓取失敗」編碼成 volume=0。
 * 這個過濾器放在共用寫入邊界，避免任何 cron、repair 或互動式查詢繞過守門。
 */
export function filterIncompleteMarketIndexCandles(symbol: string, candles: Candle[]): Candle[] {
  if (!isTrackedMarketIndex(symbol)) return candles;
  return candles.filter((candle) => isCompleteMarketIndexCandle(candle));
}

export function shouldRefreshMarketIndex(
  symbol: string,
  data: { lastDate: string; candles: Candle[] } | null,
  expectedDate: string,
): boolean {
  if (!data) return true;
  if (!isTrackedMarketIndex(symbol)) return data.lastDate < expectedDate;
  return !isCompleteMarketIndexCandle(data.candles.find((candle) => candle.date === expectedDate));
}

export function evaluateMarketIndexQuality(
  symbol: string,
  data: { lastDate: string; candles: Candle[] } | null,
  expectedDate: string,
): MarketIndexQualityItem {
  if (!data) {
    return { symbol, expectedDate, lastDate: null, volume: null, complete: false, reason: 'missing-file' };
  }

  const candle = data.candles.find((item) => item.date === expectedDate);
  if (!candle) {
    return {
      symbol,
      expectedDate,
      lastDate: data.lastDate,
      volume: null,
      complete: false,
      reason: 'missing-date',
    };
  }

  const pricesValid = Number.isFinite(candle.open) && candle.open > 0
    && Number.isFinite(candle.high) && candle.high > 0
    && Number.isFinite(candle.low) && candle.low > 0
    && Number.isFinite(candle.close) && candle.close > 0
    && candle.low <= candle.open && candle.open <= candle.high
    && candle.low <= candle.close && candle.close <= candle.high;
  if (!pricesValid) {
    return {
      symbol,
      expectedDate,
      lastDate: data.lastDate,
      volume: candle.volume,
      complete: false,
      reason: 'invalid-ohlc',
    };
  }
  if (!Number.isFinite(candle.volume) || candle.volume <= 0) {
    return {
      symbol,
      expectedDate,
      lastDate: data.lastDate,
      volume: candle.volume,
      complete: false,
      reason: 'missing-volume',
    };
  }

  return {
    symbol,
    expectedDate,
    lastDate: data.lastDate,
    volume: candle.volume,
    complete: true,
  };
}
