export interface QuoteProbeIssue {
  surface: 'portfolio' | 'single' | 'chart';
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
  };
}

type BatchQuote = { symbol?: string; asOf?: string | null; stale?: boolean; staleReason?: string };

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
  const symbols = [...new Set(args.symbols.filter(Boolean))].slice(0, 50);
  const sentinels = [...new Set(args.sentinels ?? symbols.slice(0, 2))].slice(0, 2);
  const issues: QuoteProbeIssue[] = [];
  const surfaces = { portfolio: true, single: true, chart: true };
  const origin = args.baseUrl.replace(/\/$/, '');

  try {
    const json = await fetchJson(`${origin}/api/portfolio/quotes?symbols=${encodeURIComponent(symbols.join(','))}`);
    const quotes = Array.isArray(json.quotes) ? json.quotes as BatchQuote[] : [];
    for (const symbol of symbols) {
      const quote = quotes.find(item => item.symbol === symbol);
      if (!quote) {
        issues.push({ surface: 'portfolio', symbol, reason: '批次報價缺少此股票' });
      } else if (quote.stale || !quote.asOf || quote.asOf < args.expectedDate) {
        issues.push({
          surface: 'portfolio',
          symbol,
          reason: quote.staleReason ?? `批次報價日期 ${quote.asOf ?? '未知'}，預期 ${args.expectedDate}`,
        });
      }
    }
  } catch (error) {
    surfaces.portfolio = false;
    issues.push({ surface: 'portfolio', symbol: '*', reason: error instanceof Error ? error.message : String(error) });
  }

  const singleChecks = sentinels.map(async symbol => {
    try {
      const json = await fetchJson(`${origin}/api/stock/quote?symbol=${encodeURIComponent(symbol)}`);
      const date = typeof json.date === 'string' ? json.date : null;
      if (json.stale === true || !date || date < args.expectedDate) {
        issues.push({ surface: 'single', symbol, reason: `單股報價日期 ${date ?? '未知'}，預期 ${args.expectedDate}` });
      }
    } catch (error) {
      surfaces.single = false;
      issues.push({ surface: 'single', symbol, reason: error instanceof Error ? error.message : String(error) });
    }
  });

  const chartChecks = sentinels.map(async symbol => {
    try {
      const json = await fetchJson(
        `${origin}/api/stock?symbol=${encodeURIComponent(symbol)}&interval=1d&period=1mo`,
      );
      const candles = Array.isArray(json.candles) ? json.candles as Array<{ date?: string }> : [];
      const date = candles.at(-1)?.date ?? null;
      if (!date || date < args.expectedDate) {
        issues.push({ surface: 'chart', symbol, reason: `K 線最後日期 ${date ?? '未知'}，預期 ${args.expectedDate}` });
      }
    } catch (error) {
      surfaces.chart = false;
      issues.push({ surface: 'chart', symbol, reason: error instanceof Error ? error.message : String(error) });
    }
  });

  await Promise.all([...singleChecks, ...chartChecks]);

  return {
    ok: issues.length === 0,
    checkedAt: new Date().toISOString(),
    expectedDate: args.expectedDate,
    symbols,
    issues,
    surfaces,
  };
}
