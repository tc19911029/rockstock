import type { CnStockMasterEntry } from './types';

const API_BASE = process.env.CN_MEDIA_DATA_API_BASE || 'http://localhost:3000';

export interface CnDimension<T> {
  data: T | null;
  source: string;
  fetched_at: string;
  freshness: 'fresh' | 'stale' | 'unavailable' | 'error';
  error: string | null;
}
export interface CnStockDataBundle {
  stock_code: string;
  stock_symbol: string;
  stock_name: string;
  technical: CnDimension<unknown>;
  chip: CnDimension<unknown>;
  fundamental: CnDimension<unknown>;
  news: CnDimension<unknown>;
  industry: CnDimension<unknown>;
}

async function fetchJson(url: string, timeoutMs = 45_000): Promise<Record<string, unknown>> {
  const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), cache: 'no-store' });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return await response.json() as Record<string, unknown>;
}

function dimensionError<T>(url: string, error: unknown): CnDimension<T> {
  return {
    data: null, source: url, fetched_at: new Date().toISOString(), freshness: 'error',
    error: (error as Error).message,
  };
}

function pct(current: number, base: number): number | null {
  return base ? Number((((current - base) / base) * 100).toFixed(2)) : null;
}

async function loadTechnical(stock: CnStockMasterEntry): Promise<CnDimension<unknown>> {
  const url = `${API_BASE}/api/stock?symbol=${encodeURIComponent(stock.symbol)}&interval=1d&period=3mo`;
  const fetchedAt = new Date().toISOString();
  try {
    const response = await fetchJson(url);
    const candles = (response.candles ?? []) as Array<Record<string, unknown>>;
    if (!candles.length) return { data: null, source: url, fetched_at: fetchedAt, freshness: 'unavailable', error: 'no candles' };
    const close = (row: Record<string, unknown>) => Number(row.close ?? row.c ?? 0);
    const last = candles.at(-1)!;
    const closes = candles.map(close).filter(Number.isFinite);
    const average = (values: number[]) => values.length
      ? Number((values.reduce((sum, value) => sum + value, 0) / values.length).toFixed(3))
      : null;
    const ma20 = average(closes.slice(-20));
    const lastClose = close(last);
    const max20 = Math.max(...candles.slice(-20).map(row => Number(row.high ?? row.h ?? 0)));
    return {
      data: {
        last_candle: last,
        trend_summary: {
          change_pct_1d: candles.length > 1 ? pct(lastClose, close(candles.at(-2)!)) : null,
          change_pct_5d: candles.length > 5 ? pct(lastClose, close(candles.at(-6)!)) : null,
          change_pct_20d: candles.length > 20 ? pct(lastClose, close(candles.at(-21)!)) : null,
          ma5: average(closes.slice(-5)), ma10: average(closes.slice(-10)), ma20,
          ma60: closes.length >= 60 ? average(closes.slice(-60)) : null,
          above_ma20_pct: ma20 ? pct(lastClose, ma20) : null,
          pct_off_20d_high: max20 ? pct(lastClose, max20) : null,
        },
      },
      source: url, fetched_at: fetchedAt, freshness: 'fresh', error: null,
    };
  } catch (error) { return dimensionError(url, error); }
}

async function loadChip(stock: CnStockMasterEntry): Promise<CnDimension<unknown>> {
  const url = `${API_BASE}/api/cn/chips/${stock.code}`;
  try {
    const response = await fetchJson(url);
    return {
      data: {
        shareholder_history: response.shareholders ?? [],
        dragon_tiger: response.dragontiger ?? [],
        capital_flow: response.capitalFlow ?? [],
        capital_flow_today: response.capitalFlowToday ?? null,
        main_buy_sell: response.mainBuySell ?? null,
        margin: response.margin ?? [],
      },
      source: url, fetched_at: new Date().toISOString(), freshness: 'fresh', error: null,
    };
  } catch (error) { return dimensionError(url, error); }
}

async function loadFundamental(stock: CnStockMasterEntry): Promise<CnDimension<unknown>> {
  const url = `${API_BASE}/api/cn/financials/${stock.code}`;
  try {
    const response = await fetchJson(url);
    return {
      data: { quarters: response.financials ?? [], valuation: response.valuation ?? null },
      source: url, fetched_at: new Date().toISOString(), freshness: 'fresh', error: null,
    };
  } catch (error) { return dimensionError(url, error); }
}

async function loadNews(stock: CnStockMasterEntry): Promise<CnDimension<unknown>> {
  const url = `${API_BASE}/api/news/${stock.code}?name=${encodeURIComponent(stock.name)}`;
  try {
    const response = await fetchJson(url);
    const articles = (response.articles ?? []) as Array<Record<string, unknown>>;
    return {
      data: {
        item_count: articles.length,
        recent_titles: articles.slice(0, 5).map(article => String(article.title ?? '')),
        aggregate_sentiment: response.aggregateSentiment ?? null,
      },
      source: url, fetched_at: new Date().toISOString(), freshness: 'fresh', error: null,
    };
  } catch (error) { return dimensionError(url, error); }
}

export async function loadCnStockBundle(stock: CnStockMasterEntry): Promise<CnStockDataBundle> {
  const [technical, chip, fundamental, news] = await Promise.all([
    loadTechnical(stock), loadChip(stock), loadFundamental(stock), loadNews(stock),
  ]);
  return {
    stock_code: stock.code,
    stock_symbol: stock.symbol,
    stock_name: stock.name,
    technical, chip, fundamental, news,
    industry: {
      data: { industry: stock.industry, exchange: stock.exchange },
      source: 'local:cn-stock-master', fetched_at: new Date().toISOString(),
      freshness: stock.industry ? 'fresh' : 'unavailable', error: stock.industry ? null : 'industry missing',
    },
  };
}

export async function loadCnStockBundles(
  stocks: CnStockMasterEntry[],
  concurrency = 3,
): Promise<CnStockDataBundle[]> {
  const output: CnStockDataBundle[] = [];
  for (let index = 0; index < stocks.length; index += concurrency) {
    output.push(...await Promise.all(stocks.slice(index, index + concurrency).map(loadCnStockBundle)));
  }
  return output;
}

async function loadIndex(symbol: string): Promise<Record<string, unknown> | null> {
  const indexNames: Record<string, string> = {
    '000001.SS': '上證指數',
    '399001.SZ': '深證成指',
    '399006.SZ': '創業板指',
  };
  const entry: CnStockMasterEntry = {
    code: symbol.split('.')[0], symbol, name: indexNames[symbol] ?? '指數名稱待補', exchange: symbol.endsWith('.SS') ? 'SSE' : 'SZSE',
    industry: null, aliases: [],
  };
  const result = await loadTechnical(entry);
  return result.data as Record<string, unknown> | null;
}

export async function loadCnMacro(): Promise<CnDimension<unknown>> {
  const fetchedAt = new Date().toISOString();
  const sources = ['000001.SS', '399001.SZ', '399006.SZ'];
  try {
    const [sse, szse, chinext] = await Promise.all(sources.map(loadIndex));
    const above = Number((sse?.trend_summary as Record<string, unknown> | undefined)?.above_ma20_pct);
    const regime = Number.isFinite(above) ? (above > 2 ? '多頭' : above < -2 ? '空頭' : '盤整') : 'unknown';
    return {
      data: { sse, szse, chinext, market_regime: regime },
      source: sources.map(symbol => `${API_BASE}/api/stock?symbol=${symbol}`).join(' | '),
      fetched_at: fetchedAt, freshness: sse ? 'fresh' : 'unavailable', error: null,
    };
  } catch (error) { return dimensionError(sources.join('|'), error); }
}
