export interface QuoteProbeIssue {
  surface: 'portfolio' | 'single' | 'chart' | 'realtime';
  symbol: string;
  reason: string;
}

export interface QuoteEndToEndResult {
  ok: boolean;
  checkedAt: string;
  expectedDate: string;
  symbols: string[];
  issues: QuoteProbeIssue[];
  surfaces: {
    portfolio: boolean;
    single: boolean;
    chart: boolean;
    realtime: boolean;
  };
}

type BatchQuote = {
  symbol?: string;
  price?: number;
  asOf?: string | null;
  stale?: boolean;
  staleReason?: string;
};

function samePrice(left: number | undefined, right: number | undefined): boolean {
  if (!(left && left > 0) || !(right && right > 0)) return false;
  return Math.abs(left - right) <= Math.max(0.0001, Math.abs(left) * 1e-8);
}

async function fetchJson(url: string): Promise<Record<string, unknown>> {
  const response = await fetch(url, { cache: 'no-store', signal: AbortSignal.timeout(15_000) });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json() as Promise<Record<string, unknown>>;
}

/** 從使用者實際使用的三個 API 出口驗證「應有今天價格時不可回昨天」。 */
export async function runQuoteEndToEndProbe(args: {
  baseUrl: string;
  symbols: string[];
  expectedDate: string;
  sentinels?: string[];
}): Promise<QuoteEndToEndResult> {
  const requestedSentinels = [...new Set((args.sentinels ?? args.symbols.slice(0, 2)).filter(Boolean))].slice(0, 2);
  // Price equality needs a batch baseline for every sentinel, even when a custom
  // health request did not explicitly include the default sentinel symbols.
  const symbols = [...new Set([...requestedSentinels, ...args.symbols.filter(Boolean)])].slice(0, 50);
  const sentinels = requestedSentinels.filter(symbol => symbols.includes(symbol));
  const issues: QuoteProbeIssue[] = [];
  const surfaces = { portfolio: true, single: true, chart: true, realtime: true };
  const origin = args.baseUrl.replace(/\/$/, '');
  const batchBySymbol = new Map<string, BatchQuote>();

  try {
    const json = await fetchJson(`${origin}/api/portfolio/quotes?symbols=${encodeURIComponent(symbols.join(','))}`);
    const quotes = Array.isArray(json.quotes) ? json.quotes as BatchQuote[] : [];
    for (const symbol of symbols) {
      const quote = quotes.find(item => item.symbol === symbol);
      if (!quote) {
        issues.push({ surface: 'portfolio', symbol, reason: '批次報價缺少此股票' });
      } else if (quote.stale || quote.asOf !== args.expectedDate) {
        issues.push({
          surface: 'portfolio',
          symbol,
          reason: quote.staleReason ?? `批次報價日期 ${quote.asOf ?? '未知'}，預期 ${args.expectedDate}`,
        });
      } else if (!(quote.price && quote.price > 0)) {
        issues.push({ surface: 'portfolio', symbol, reason: '批次報價沒有有效價格' });
      }
      if (quote) batchBySymbol.set(symbol, quote);
    }
  } catch (error) {
    surfaces.portfolio = false;
    issues.push({ surface: 'portfolio', symbol: '*', reason: error instanceof Error ? error.message : String(error) });
  }

  const singleChecks = sentinels.map(async symbol => {
    try {
      const json = await fetchJson(`${origin}/api/stock/quote?symbol=${encodeURIComponent(symbol)}`);
      const date = typeof json.date === 'string' ? json.date : null;
      const price = typeof json.close === 'number' ? json.close : undefined;
      const batchPrice = batchBySymbol.get(symbol)?.price;
      if (json.stale === true || date !== args.expectedDate) {
        issues.push({ surface: 'single', symbol, reason: `單股報價日期 ${date ?? '未知'}，預期 ${args.expectedDate}` });
      } else if (!samePrice(price, batchPrice)) {
        issues.push({ surface: 'single', symbol, reason: `單股價 ${price ?? '無'} 與持股價 ${batchPrice ?? '無'} 不一致` });
      }
    } catch (error) {
      surfaces.single = false;
      issues.push({ surface: 'single', symbol, reason: error instanceof Error ? error.message : String(error) });
    }
  });

  const chartChecks = sentinels.map(async symbol => {
    try {
      const json = await fetchJson(
        `${origin}/api/stock?symbol=${encodeURIComponent(symbol)}&interval=1d&period=1mo&local=1`,
      );
      const candles = Array.isArray(json.candles) ? json.candles as Array<{ date?: string; close?: number }> : [];
      const last = candles.at(-1);
      const date = last?.date ?? null;
      const batchPrice = batchBySymbol.get(symbol)?.price;
      if (date !== args.expectedDate) {
        issues.push({ surface: 'chart', symbol, reason: `K 線最後日期 ${date ?? '未知'}，預期 ${args.expectedDate}` });
      } else if (!samePrice(last?.close, batchPrice)) {
        issues.push({ surface: 'chart', symbol, reason: `主圖價 ${last?.close ?? '無'} 與持股價 ${batchPrice ?? '無'} 不一致` });
      }
    } catch (error) {
      surfaces.chart = false;
      issues.push({ surface: 'chart', symbol, reason: error instanceof Error ? error.message : String(error) });
    }
  });

  const realtimeCheck = (async () => {
    if (sentinels.length === 0) return;
    try {
      const json = await fetchJson(`${origin}/api/realtime?symbols=${encodeURIComponent(sentinels.join(','))}`);
      const quotes = Array.isArray(json.quotes)
        ? json.quotes as Array<{ symbol?: string; price?: number; date?: string | null; stale?: boolean }>
        : [];
      for (const symbol of sentinels) {
        const code = symbol.replace(/\.(TW|TWO)$/i, '');
        const quote = quotes.find(item => item.symbol === code);
        const batchPrice = batchBySymbol.get(symbol)?.price;
        if (!quote) {
          issues.push({ surface: 'realtime', symbol, reason: '舊即時表格出口缺少此股票' });
        } else if (quote.stale || quote.date !== args.expectedDate) {
          issues.push({ surface: 'realtime', symbol, reason: `即時表格日期 ${quote.date ?? '未知'}，預期 ${args.expectedDate}` });
        } else if (!samePrice(quote.price, batchPrice)) {
          issues.push({ surface: 'realtime', symbol, reason: `即時表格價 ${quote.price ?? '無'} 與持股價 ${batchPrice ?? '無'} 不一致` });
        }
      }
    } catch (error) {
      surfaces.realtime = false;
      issues.push({ surface: 'realtime', symbol: '*', reason: error instanceof Error ? error.message : String(error) });
    }
  })();

  await Promise.all([...singleChecks, ...chartChecks, realtimeCheck]);
  for (const surface of Object.keys(surfaces) as Array<keyof typeof surfaces>) {
    if (issues.some(issue => issue.surface === surface)) surfaces[surface] = false;
  }

  return {
    ok: issues.length === 0,
    checkedAt: new Date().toISOString(),
    expectedDate: args.expectedDate,
    symbols,
    issues,
    surfaces,
  };
}
