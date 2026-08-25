import type { EastMoneyQuote } from '@/lib/datasource/EastMoneyRealtime';
import type { IntradaySnapshot } from '@/lib/datasource/IntradayCache';
import { assessIntradayFreshness } from '@/lib/datasource/intradayFreshness';

export interface CNRealtimeBatchQuote {
  close: number;
  volume: number;
  high?: number;
  prevClose?: number;
}

export type CNRealtimeBatchSource = 'tencent' | 'tencent+sina' | 'sina' | 'l2-snapshot' | 'unavailable';

interface CNRealtimeQuoteDependencies {
  fetchTencent(symbols: string[]): Promise<Map<string, EastMoneyQuote>>;
  fetchSina(symbols: string[]): Promise<Map<string, EastMoneyQuote>>;
  readSnapshot(date: string): Promise<IntradaySnapshot | null>;
  now(): Date;
}

const defaultDependencies: CNRealtimeQuoteDependencies = {
  async fetchTencent(symbols) {
    const { getTencentRealtime } = await import('@/lib/datasource/TencentRealtime');
    return getTencentRealtime(symbols);
  },
  async fetchSina(symbols) {
    const { getSinaRealtime } = await import('@/lib/datasource/SinaRealtime');
    return getSinaRealtime(symbols);
  },
  async readSnapshot(date) {
    const { readIntradaySnapshot } = await import('@/lib/datasource/IntradayCache');
    return readIntradaySnapshot('CN', date);
  },
  now: () => new Date(),
};

function normalizeVendorQuotes(map: Map<string, EastMoneyQuote>): Map<string, CNRealtimeBatchQuote> {
  const out = new Map<string, CNRealtimeBatchQuote>();
  for (const [code, q] of map) {
    if (!(q.close > 0)) continue;
    out.set(code, {
      close: q.close,
      volume: q.volume,
      high: q.high,
      prevClose: q.prevClose,
    });
  }
  return out;
}

function mergeMissing(
  target: Map<string, CNRealtimeBatchQuote>,
  source: Map<string, CNRealtimeBatchQuote>,
): void {
  for (const [code, quote] of source) {
    if (!target.has(code)) target.set(code, quote);
  }
}

function targetCodes(symbols: string[]): Set<string> {
  return new Set(symbols.map(symbol => symbol.split('.')[0]).filter(code => /^\d{6}$/.test(code)));
}

/**
 * 取得 A 股監看池即時報價。
 *
 * realtime-scan 每 30 秒執行，只需要持倉與監看池，不應為十幾檔股票抓 EastMoney
 * 全市場 50+ 頁。Tencent 與 Sina 都支援目標代碼批次；兩者不足時才讀既有的新鮮
 * L2 快照，讓上游短暫斷線時持倉停損／拉高回落保護仍有安全備援。
 */
export async function fetchCNRealtimeQuoteBatch(
  symbols: string[],
  dependencies: CNRealtimeQuoteDependencies = defaultDependencies,
): Promise<{ quotes: Map<string, CNRealtimeBatchQuote>; source: CNRealtimeBatchSource }> {
  const codes = targetCodes(symbols);
  if (codes.size === 0) return { quotes: new Map(), source: 'unavailable' };

  const requestedSymbols = [...codes].map(code =>
    `${code}.${code[0] === '6' || code[0] === '9' ? 'SS' : 'SZ'}`,
  );
  const quotes = new Map<string, CNRealtimeBatchQuote>();
  let tencentCount = 0;
  let sinaCount = 0;

  try {
    const tencent = normalizeVendorQuotes(await dependencies.fetchTencent(requestedSymbols));
    for (const [code, quote] of tencent) {
      if (codes.has(code)) quotes.set(code, quote);
    }
    tencentCount = quotes.size;
  } catch (error) {
    console.warn('[CNRealtimeQuoteSource] Tencent 失敗:', error instanceof Error ? error.message : String(error));
  }

  if (quotes.size < codes.size) {
    const missing = requestedSymbols.filter(symbol => !quotes.has(symbol.split('.')[0]));
    try {
      const sina = normalizeVendorQuotes(await dependencies.fetchSina(missing));
      const before = quotes.size;
      for (const [code, quote] of sina) {
        if (codes.has(code) && !quotes.has(code)) quotes.set(code, quote);
      }
      sinaCount = quotes.size - before;
    } catch (error) {
      console.warn('[CNRealtimeQuoteSource] Sina 失敗:', error instanceof Error ? error.message : String(error));
    }
  }

  if (quotes.size < codes.size) {
    const now = dependencies.now();
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(now);
    try {
      const snapshot = await dependencies.readSnapshot(today);
      if (snapshot && !assessIntradayFreshness('CN', snapshot, now).stale) {
        const snapshotQuotes = new Map<string, CNRealtimeBatchQuote>();
        for (const q of snapshot.quotes) {
          if (!codes.has(q.symbol) || !(q.close > 0)) continue;
          snapshotQuotes.set(q.symbol, {
            close: q.close,
            volume: q.volume,
            high: q.high,
            prevClose: q.prevClose,
          });
        }
        mergeMissing(quotes, snapshotQuotes);
      }
    } catch (error) {
      console.warn('[CNRealtimeQuoteSource] L2 snapshot 失敗:', error instanceof Error ? error.message : String(error));
    }
  }

  const source: CNRealtimeBatchSource = tencentCount > 0
    ? (sinaCount > 0 ? 'tencent+sina' : 'tencent')
    : sinaCount > 0
      ? 'sina'
      : quotes.size > 0
        ? 'l2-snapshot'
        : 'unavailable';
  return { quotes, source };
}
