// lib/datasource/DataProvider.ts
import { Candle, CandleWithIndicators } from '@/types';

export interface PriceQuote {
  symbol: string;
  name: string;
  price: number;
  changePercent: number;
  volume: number;
  timestamp: number;
}

export interface DataProviderOptions {
  timeoutMs?: number;
}

/**
 * 統一資料來源介面 — 所有 provider 必須實作此介面。
 * 這樣未來可以無痛切換到其他資料來源（台灣證交所、TEJ、本地快取等）。
 */
export interface DataProvider {
  /** Provider 名稱，用於 logging 和偵錯 */
  readonly name: string;

  /**
   * 取得歷史日 K 資料（含指標）
   * @param symbol  股票代號（含交易所後綴，如 2330.TW）
   * @param period  'Ny' 格式，如 '1y' '2y' '5y'
   * @param asOfDate YYYY-MM-DD，若提供則只回傳截至該日的資料（防止未來函數）
   */
  getHistoricalCandles(
    symbol: string,
    period: string,
    asOfDate?: string,
  ): Promise<CandleWithIndicators[]>;

  /**
   * 取得指定日期範圍的原始 K 線（不含指標，用於回測後向分析）
   */
  getCandlesRange(
    symbol: string,
    startDate: string,
    endDate: string,
  ): Promise<Candle[]>;
}
