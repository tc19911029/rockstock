import type { IntradaySnapshot } from '@/lib/datasource/IntradayCache';
import { assessIntradayFreshness } from '@/lib/datasource/intradayFreshness';
import { fetchJsonWithCurlFallback } from '@/lib/datasource/curlFetch';
import {
  parseMisDate,
  parseMisPrice,
  parseMisUpdatedAt,
  resolveMisTradePrice,
} from '@/lib/datasource/TWSERealtime';

export interface TWRealtimeBatchQuote {
  /** 最近一筆可確認的成交價；不使用委買賣中價冒充成交。 */
  close: number;
  /** MIS 當日累積成交量，單位為張。 */
  volume: number;
  high?: number;
  prevClose?: number;
  isActualTrade: boolean;
  observedAt?: string;
}

export type TWRealtimeBatchSource =
  | 'mis-targeted'
  | 'mis-targeted+l2'
  | 'l2-snapshot'
  | 'unavailable';

interface MisResponse {
  msgArray?: Array<Record<string, string | undefined>>;
}

export interface TWRealtimeQuoteDependencies {
  fetchMis(url: string): Promise<MisResponse>;
  readSnapshot(date: string): Promise<IntradaySnapshot | null>;
  now(): Date;
}

const MIS_HEADERS: Record<string, string> = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Referer': 'https://mis.twse.com.tw/stock/fibest.jsp',
  'Accept': 'application/json, text/javascript, */*; q=0.01',
  'Accept-Language': 'zh-TW,zh;q=0.9,en;q=0.8',
};

const TARGET_BATCH_SIZE = 40; // 每檔同查 tse/otc，40 檔 = 80 channels，低於 MIS 實測上限 100。
const lastActualPrice = new Map<string, number>();
let priceStateDate = '';

const defaultDependencies: TWRealtimeQuoteDependencies = {
  async fetchMis(url) {
    const { data } = await fetchJsonWithCurlFallback<MisResponse>(url, {
      headers: MIS_HEADERS,
      timeoutMs: 4_000,
      proxyFirst: true,
    });
    return data;
  },
  async readSnapshot(date) {
    const { readIntradaySnapshot } = await import('@/lib/datasource/IntradayCache');
    return readIntradaySnapshot('TW', date);
  },
  now: () => new Date(),
};

function targetCodes(symbols: string[]): string[] {
  return [...new Set(
    symbols
      .map(symbol => symbol.split('.')[0])
      .filter(code => /^\d{4,6}$/.test(code)),
  )];
}

function positiveInt(value: string | undefined): number {
  const parsed = Number.parseInt((value ?? '').replace(/,/g, ''), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

function actualPriceFromSnapshot(snapshot: IntradaySnapshot | null, code: string): number {
  const quote = snapshot?.quotes.find(item => item.symbol === code);
  if (!quote) return 0;
  if (quote.lastActualPrice && quote.lastActualPrice > 0) return quote.lastActualPrice;
  if (quote.priceKind === 'indicative' || quote.priceKind === 'unavailable' || quote.isActualTrade === false) return 0;
  return quote.close > 0 ? quote.close : 0;
}

/**
 * 只查 realtime-scan 監控池，不再為幾十檔股票等待兩千檔全市場快照刷新。
 * MIS 某次沒有新撮合時 z 會是「-」；此時沿用最後確認成交價，只用累積量更新 bar，
 * 絕不把委買賣中價當成交。既有且新鮮的 L2 快照只作冷啟動成交價備援。
 */
export async function fetchTWRealtimeQuoteBatch(
  symbols: string[],
  dependencies: TWRealtimeQuoteDependencies = defaultDependencies,
): Promise<{ quotes: Map<string, TWRealtimeBatchQuote>; source: TWRealtimeBatchSource }> {
  const codes = targetCodes(symbols);
  if (codes.length === 0) return { quotes: new Map(), source: 'unavailable' };

  const now = dependencies.now();
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Taipei' }).format(now);
  if (priceStateDate !== today) {
    lastActualPrice.clear();
    priceStateDate = today;
  }

  const needsSnapshotSeed = codes.some(code => !lastActualPrice.has(code));
  const loadFreshSnapshot = async (): Promise<IntradaySnapshot | null> => {
    try {
      const candidate = await dependencies.readSnapshot(today);
      return candidate && !assessIntradayFreshness('TW', candidate, now).stale ? candidate : null;
    } catch (error) {
      console.warn('[TWRealtimeQuoteSource] L2 snapshot 讀取失敗:', error instanceof Error ? error.message : String(error));
      return null;
    }
  };
  const snapshotPromise = needsSnapshotSeed ? loadFreshSnapshot() : Promise.resolve(null);

  const rows: Array<Record<string, string | undefined>> = [];
  let successfulBatches = 0;
  const jobs: Promise<void>[] = [];
  for (let i = 0; i < codes.length; i += TARGET_BATCH_SIZE) {
    const chunk = codes.slice(i, i + TARGET_BATCH_SIZE);
    jobs.push((async () => {
      const channels = chunk.flatMap(code => [`tse_${code}.tw`, `otc_${code}.tw`]);
      const url = `https://mis.twse.com.tw/stock/api/getStockInfo.jsp?ex_ch=${channels.join('|')}&json=1&delay=0&_=${now.getTime()}`;
      try {
        const response = await dependencies.fetchMis(url);
        successfulBatches++;
        rows.push(...(response.msgArray ?? []));
      } catch (error) {
        console.warn(`[TWRealtimeQuoteSource] MIS 目標批次失敗 (${chunk.length} 檔):`, error instanceof Error ? error.message : String(error));
      }
    })());
  }
  await Promise.all(jobs);
  let snapshot = await snapshotPromise;
  // 暖狀態正常輪不讀 L2；只有 MIS 批次失敗時才補讀一次新鮮快照作保命備援。
  if (!snapshot && successfulBatches < jobs.length) snapshot = await loadFreshSnapshot();

  const requested = new Set(codes);
  const quotes = new Map<string, TWRealtimeBatchQuote>();
  let l2Used = false;
  for (const row of rows) {
    const code = row.c ?? '';
    if (!requested.has(code) || parseMisDate(row.d) !== today) continue;
    const actual = resolveMisTradePrice(row);
    if (actual > 0) lastActualPrice.set(code, actual);
    let close = actual || lastActualPrice.get(code) || 0;
    if (close <= 0) {
      close = actualPriceFromSnapshot(snapshot, code);
      if (close > 0) {
        lastActualPrice.set(code, close);
        l2Used = true;
      }
    }
    if (close <= 0) continue;
    const high = parseMisPrice(row.h);
    const prevClose = parseMisPrice(row.y);
    quotes.set(code, {
      close,
      volume: positiveInt(row.v),
      high: high > 0 ? high : undefined,
      prevClose: prevClose > 0 ? prevClose : undefined,
      isActualTrade: actual > 0,
      observedAt: parseMisUpdatedAt(row),
    });
  }

  // MIS 整批或部分掛掉時，缺失股票的保命規則仍可使用既有新鮮 L2；
  // 快照累積量不前進，因此不會憑空製造新的 volume delta。
  if (quotes.size < codes.length && snapshot) {
    for (const quote of snapshot.quotes) {
      if (!requested.has(quote.symbol) || quotes.has(quote.symbol)) continue;
      const close = actualPriceFromSnapshot(snapshot, quote.symbol);
      if (close <= 0) continue;
      quotes.set(quote.symbol, {
        close,
        volume: quote.volume,
        high: quote.high > 0 ? quote.high : undefined,
        prevClose: quote.prevClose > 0 ? quote.prevClose : undefined,
        isActualTrade: false,
        observedAt: quote.lastActualAt ?? quote.observedAt,
      });
    }
    if (quotes.size > 0) l2Used = true;
  }

  const source: TWRealtimeBatchSource = successfulBatches > 0
    ? (l2Used ? 'mis-targeted+l2' : 'mis-targeted')
    : quotes.size > 0
      ? 'l2-snapshot'
      : 'unavailable';
  return { quotes, source };
}

/** test-only */
export function _resetTWRealtimeQuoteStateForTest(): void {
  lastActualPrice.clear();
  priceStateDate = '';
}
