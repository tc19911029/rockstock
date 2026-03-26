import { CandleWithIndicators } from '@/types';
import { fetchCandlesYahoo } from '@/lib/datasource/YahooFinanceDS';
import { MarketScanner } from './MarketScanner';
import { MarketConfig } from './types';

type StockEntry = { symbol: string; name: string };

// Fallback list if exchange APIs are unavailable
const FALLBACK_TW_STOCKS: StockEntry[] = [
  { symbol: '2330.TW', name: '台積電' }, { symbol: '2454.TW', name: '聯發科' },
  { symbol: '2317.TW', name: '鴻海' },   { symbol: '2382.TW', name: '廣達' },
  { symbol: '2308.TW', name: '台達電' }, { symbol: '3711.TW', name: '日月光投控' },
  { symbol: '2303.TW', name: '聯電' },   { symbol: '2891.TW', name: '中信金' },
  { symbol: '2882.TW', name: '國泰金' }, { symbol: '2886.TW', name: '兆豐金' },
  { symbol: '2884.TW', name: '玉山金' }, { symbol: '2881.TW', name: '富邦金' },
  { symbol: '2885.TW', name: '元大金' }, { symbol: '2892.TW', name: '第一金' },
  { symbol: '5880.TW', name: '合庫金' }, { symbol: '2412.TW', name: '中華電' },
  { symbol: '3045.TW', name: '台灣大' }, { symbol: '4904.TW', name: '遠傳' },
  { symbol: '2002.TW', name: '中鋼' },   { symbol: '1303.TW', name: '南亞' },
  { symbol: '1301.TW', name: '台塑' },   { symbol: '6505.TW', name: '台塑化' },
  { symbol: '2912.TW', name: '統一超' }, { symbol: '2603.TW', name: '長榮' },
  { symbol: '2609.TW', name: '陽明' },   { symbol: '2615.TW', name: '萬海' },
  { symbol: '3008.TW', name: '大立光' }, { symbol: '2357.TW', name: '華碩' },
  { symbol: '2376.TW', name: '技嘉' },   { symbol: '2353.TW', name: '宏碁' },
];

type TWSERow = { Code: string; Name: string; TradeVolume?: string };
type TPExRow = { SecuritiesCompanyCode: string; CompanyName: string; TradingShares?: string };

/** 從 TWSE 取得上市股票，按當日成交量排序 */
async function fetchTWSEStocks(): Promise<(StockEntry & { vol: number })[]> {
  const res = await fetch(
    'https://openapi.twse.com.tw/v1/exchangeReport/STOCK_DAY_ALL',
    { signal: AbortSignal.timeout(15000) }
  );
  if (!res.ok) throw new Error('TWSE API error');
  const data = await res.json() as TWSERow[];
  return data
    .filter(s => /^\d{4}$/.test(s.Code))
    .map(s => ({
      symbol: `${s.Code}.TW`,
      name: s.Name,
      vol: parseInt((s.TradeVolume ?? '0').replace(/,/g, ''), 10) || 0,
    }))
    .sort((a, b) => b.vol - a.vol);
}

/** 從 TPEx 取得上櫃股票，按當日成交量排序 */
async function fetchTPExStocks(): Promise<(StockEntry & { vol: number })[]> {
  const res = await fetch(
    'https://www.tpex.org.tw/openapi/v1/tpex_mainboard_quotes',
    { signal: AbortSignal.timeout(15000) }
  );
  if (!res.ok) throw new Error('TPEx API error');
  const data = await res.json() as TPExRow[];
  return data
    .filter(s => /^\d{4}$/.test(s.SecuritiesCompanyCode))
    .map(s => ({
      symbol: `${s.SecuritiesCompanyCode}.TWO`,
      name: s.CompanyName,
      vol: parseInt((s.TradingShares ?? '0').replace(/,/g, ''), 10) || 0,
    }))
    .sort((a, b) => b.vol - a.vol);
}

export class TaiwanScanner extends MarketScanner {
  getMarketConfig(): MarketConfig {
    return {
      marketId:      'TW',
      name:          '台灣全市場',
      scanTimeLocal: '13:00',
      timezone:      'Asia/Taipei',
    };
  }

  async getStockList(): Promise<StockEntry[]> {
    const [listed, otc] = await Promise.allSettled([
      fetchTWSEStocks(),
      fetchTPExStocks(),
    ]);

    const withVol: (StockEntry & { vol: number })[] = [
      ...(listed.status === 'fulfilled' ? listed.value : []),
      ...(otc.status    === 'fulfilled' ? otc.value    : []),
    ];

    if (withVol.length === 0) {
      console.warn('[TaiwanScanner] Exchange APIs failed, using fallback list');
      return FALLBACK_TW_STOCKS;
    }

    // Deduplicate, sort by volume (highest first), take top 500
    const deduped = Array.from(new Map(withVol.map(s => [s.symbol, s])).values());
    const top500  = deduped.sort((a, b) => b.vol - a.vol).slice(0, 500);
    return top500.map(({ symbol, name }) => ({ symbol, name }));
  }

  async fetchCandles(symbol: string, asOfDate?: string): Promise<CandleWithIndicators[]> {
    return fetchCandlesYahoo(symbol, '1y', 4000, asOfDate);
  }
}
