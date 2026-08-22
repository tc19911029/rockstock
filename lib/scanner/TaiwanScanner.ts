import { CandleWithIndicators } from '@/types';
import { dataProvider } from '@/lib/datasource/MultiMarketProvider';
import { fetchCandlesTWSE } from '@/lib/datasource/TWSEDataSource';
import { MarketScanner, StockEntry } from './MarketScanner';
import { MarketConfig } from './types';
import { detectTrend, TrendState } from '@/lib/analysis/trendAnalysis';
import { getTWConcept, fetchTWIndustryMap } from './conceptMap';
import { UNRESOLVED_STOCK_NAME } from '@/lib/stocks/stockIdentity';

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

const MIN_FULL_TW_UNIVERSE = 1500;

/**
 * 交易所股票清單 API 短暫失效時，使用每日保存的交易所主檔當完整備援。
 * 僅保留和正式 scanner 相同的 4 碼普通股，避免把 ETF／權證混進掃描母體。
 */
async function loadLocalTWStockMaster(): Promise<StockEntry[]> {
  try {
    const [{ readFile }, path] = await Promise.all([
      import('node:fs/promises'),
      import('node:path'),
    ]);
    const raw = JSON.parse(await readFile(
      path.join(process.cwd(), 'data', 'youtube', 'stock-master.json'),
      'utf8',
    )) as { entries?: Array<{ code?: string; name?: string; market?: string }> };
    const stocks = (raw.entries ?? [])
      .filter((entry) =>
        /^[1-9]\d{3}$/.test(entry.code ?? '') &&
        (entry.market === 'TWSE' || entry.market === 'TPEx'),
      )
      .map((entry) => ({
        symbol: `${entry.code}.${entry.market === 'TWSE' ? 'TW' : 'TWO'}`,
        name: entry.name?.trim() || UNRESOLVED_STOCK_NAME,
      }));
    return Array.from(new Map(stocks.map((stock) => [stock.symbol, stock])).values());
  } catch (error) {
    console.warn('[TaiwanScanner] 本地主檔 fallback 載入失敗:', error);
    return [];
  }
}

type TWSERow = { Code: string; Name: string; TradeVolume?: string };
type TPExRow = { SecuritiesCompanyCode: string; CompanyName: string; TradingShares?: string };

// 產業分類（TWSE_INDUSTRY_MAP + fetchTWIndustryMap）已移到 ./conceptMap，
// 與三色掃描(tw-sanse) 共用同一份來源；此處改 import 使用。

/** 從 TWSE 取得上市股票，按當日成交量排序 */
async function fetchTWSEStocks(): Promise<(StockEntry & { vol: number })[]> {
  const res = await fetch(
    'https://openapi.twse.com.tw/v1/exchangeReport/STOCK_DAY_ALL',
    { signal: AbortSignal.timeout(15000) }
  );
  if (!res.ok) throw new Error('TWSE API error');
  const data = await res.json() as TWSERow[];
  return data
    .filter(s => /^[1-9]\d{3}$/.test(s.Code)) // 4碼且首碼1-9：排除ETF(00xx)、權證、受益憑證
    .map(s => ({
      symbol: `${s.Code}.TW`,
      name: s.Name.trim(),
      vol: parseInt((s.TradeVolume ?? '0').replace(/,/g, ''), 10) || 0,
    }))
    .sort((a, b) => b.vol - a.vol);
}

/** 從 TPEx 取得上櫃股票，按當日成交量排序
 *  Primary: TPEx openapi (Node fetch + curl fallback)  Fallback: ISIN C_public.jsp */
async function fetchTPExStocks(): Promise<(StockEntry & { vol: number })[]> {
  try {
    // 2026-05-11：Node fetch 被 Cloudflare TLS 擋（5/11 cron 為此漏 853 支上櫃），走 curl fallback
    const { fetchJsonWithCurlFallback } = await import('@/lib/datasource/curlFetch');
    const { data, source } = await fetchJsonWithCurlFallback<TPExRow[]>(
      'https://www.tpex.org.tw/openapi/v1/tpex_mainboard_quotes',
      { timeoutMs: 15000 },
    );
    if (source === 'curl') {
      console.info('[TaiwanScanner] fetchTPExStocks 經 curl fallback 成功');
    }
    const stocks = data
      .filter(s => /^[1-9]\d{3,4}$/.test(s.SecuritiesCompanyCode))
      .map(s => ({
        symbol: `${s.SecuritiesCompanyCode}.TWO`,
        name: s.CompanyName.trim(),
        vol: parseInt((s.TradingShares ?? '0').replace(/,/g, ''), 10) || 0,
      }))
      .sort((a, b) => b.vol - a.vol);
    if (stocks.length > 0) return stocks;
  } catch { /* TPEx blocked or down, fall through to ISIN */ }

  // ISIN C_public.jsp?strMode=4 — Big5 HTML，未被 Cloudflare 封鎖
  const isinRes = await fetch(
    'https://isin.twse.com.tw/isin/C_public.jsp?strMode=4',
    { signal: AbortSignal.timeout(15000) }
  );
  if (!isinRes.ok) throw new Error('TPEx API error');
  const buf = await isinRes.arrayBuffer();
  const text = new TextDecoder('big5').decode(buf);
  const stocks: (StockEntry & { vol: number })[] = [];
  for (const [, code, name] of text.matchAll(
    /bgcolor=#FAFAD2>([1-9]\d{3,4})　([^<]+?)<\/td><td bgcolor=#FAFAD2>(TW\d{10})<\/td>/g,
  )) {
    stocks.push({ symbol: `${code}.TWO`, name: name.trim(), vol: 0 });
  }
  if (stocks.length === 0) throw new Error('TPEx API error');
  return stocks;
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
    const [listed, otc, industryMap] = await Promise.allSettled([
      fetchTWSEStocks(),
      fetchTPExStocks(),
      fetchTWIndustryMap(),
    ]);

    let withVol: (StockEntry & { vol: number })[] = [
      ...(listed.status === 'fulfilled' ? listed.value : []),
      ...(otc.status    === 'fulfilled' ? otc.value    : []),
    ];

    if (withVol.length < MIN_FULL_TW_UNIVERSE) {
      const localMaster = await loadLocalTWStockMaster();
      if (localMaster.length >= MIN_FULL_TW_UNIVERSE) {
        // 交易所即時清單優先（保留成交量排序與最新名稱），本地主檔只補缺漏市場。
        const merged = new Map<string, StockEntry & { vol: number }>(
          withVol.map((stock) => [stock.symbol, stock]),
        );
        for (const stock of localMaster) {
          if (!merged.has(stock.symbol)) merged.set(stock.symbol, { ...stock, vol: 0 });
        }
        console.warn(
          `[TaiwanScanner] 交易所清單僅 ${withVol.length} 支，` +
          `已用本地主檔補成 ${merged.size} 支`,
        );
        withVol = [...merged.values()];
      }
    }

    if (withVol.length === 0) {
      // 僅保留給非全市場的互動式查詢；verifyDownload 另有硬性母體守門，
      // 此 30 檔清單不可能再覆寫全市場驗證報告。
      return FALLBACK_TW_STOCKS;
    }

    const indMap = industryMap.status === 'fulfilled' ? industryMap.value : new Map<string, string>();

    // Deduplicate, sort by volume (highest first) — 全部台股不設上限
    const deduped = Array.from(new Map(withVol.map(s => [s.symbol, s])).values());
    const sorted  = deduped.sort((a, b) => b.vol - a.vol);
    return sorted.map(({ symbol, name }) => {
      const code = symbol.replace(/\.(TW|TWO)$/i, '');
      return { symbol, name, industry: getTWConcept(code, indMap.get(code)) };
    });
  }

  async fetchCandles(symbol: string, asOfDate?: string): Promise<CandleWithIndicators[]> {
    // MultiMarketProvider: FinMind → TWSE/TPEx 備援 + 即時覆蓋
    // 取 2 年日K（~500根）以支援多時間框架分析（月K需要 MA10 = 24 根月K）
    try {
      const candles = await dataProvider.getHistoricalCandles(symbol, '2y', asOfDate);
      if (candles.length >= 30) return candles;
    } catch {
      // dataProvider failed, try TWSE direct as last resort
    }

    // Fallback: TWSE direct API (listed stocks only, no asOfDate support)
    if (/\.TW$/i.test(symbol) && !asOfDate) {
      const ticker = symbol.replace(/\.TW$/i, '');
      try {
        const candles = await fetchCandlesTWSE(ticker);
        if (candles.length >= 30) return candles;
      } catch {
        // TWSE fallback also failed
      }
    }

    return [];
  }

  /**
   * 大盤趨勢：以 ^TWII（台灣加權指數）作為台股大盤代理指標
   * （2026-04-24 從 0050.TW 改為 ^TWII，對齊走圖預設）
   *
   * 三重檢驗：
   * 1. 長期趨勢 (detectTrend)：確保大方向多頭結構
   * 2. 短期動能：若 close < MA5 且 MA5 < MA10 → 短期修正，降為「盤整」
   * 3. 過熱乖離：若大盤收盤 > MA20 × 1.08（乖離>8%）→ 末升段過高，降為「盤整」
   *    防止在大盤到頂區域還進場（朱老師：乖離過大不追高）
   */
  /**
   * 純 ^TWII 趨勢 — UI banner / 條件面板 / 走圖三邊統一用這個
   * 不含「短期走弱降級」「乖離過大降級」副作用
   */
  async getMarketTrend(asOfDate?: string): Promise<TrendState> {
    const candles = await this.loadTwiiCandles(asOfDate);
    if (candles.length < 20) return '盤整';
    return detectTrend(candles, candles.length - 1);
  }

  /**
   * 掃描體質（含「乖離過大」「短期走弱」降級為盤整 → 提高 minScore）
   * 議題：朱老師「乖離過大不追高」精神。只給 scanLong/scanShort minScore 計算用。
   */
  async getMarketScanRegime(asOfDate?: string): Promise<TrendState> {
    try {
      const candles = await this.loadTwiiCandles(asOfDate);
      if (candles.length < 20) return '盤整';
      const lastIdx = candles.length - 1;
      const longTrend = detectTrend(candles, lastIdx);
      const last = candles[lastIdx];

      const shortTermBearish =
        last.ma5 != null && last.ma10 != null &&
        last.close < last.ma5 && last.ma5 < last.ma10;

      const marketOverheat =
        last.ma20 != null && last.ma20 > 0 &&
        last.close > last.ma20 * 1.08;

      if (longTrend === '多頭' && (shortTermBearish || marketOverheat)) {
        return '盤整';
      }
      return longTrend;
    } catch {
      return '盤整';
    }
  }

  private async loadTwiiCandles(asOfDate?: string): Promise<CandleWithIndicators[]> {
    let candles: CandleWithIndicators[] = [];
    try {
      const { loadLocalCandlesWithTolerance } = await import('@/lib/datasource/LocalCandleStore');
      const targetDate = asOfDate || new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Taipei' }).format(new Date());
      const local = await loadLocalCandlesWithTolerance('^TWII', 'TW', targetDate, 5);
      if (local && local.candles.length >= 20) {
        candles = local.candles;
      }
    } catch { /* local read failed, fallback to API */ }

    if (candles.length < 20) {
      const fetched = await dataProvider.getHistoricalCandles('^TWII', '1y', asOfDate);
      if (fetched.length >= 20) {
        const { saveLocalCandles } = await import('@/lib/datasource/LocalCandleStore');
        const raw = fetched.map(c => ({
          date: c.date, open: c.open, high: c.high,
          low: c.low, close: c.close, volume: c.volume,
        }));
        saveLocalCandles('^TWII', 'TW', raw).catch(() => {});
      }
      candles = fetched;
    }
    return candles;
  }
}
