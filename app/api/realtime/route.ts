import { NextRequest } from 'next/server';
import { z } from 'zod';
import { apiOk, apiError, apiValidationError } from '@/lib/api/response';
import { parseMisDate, parseMisPrice, parseMisUpdatedAt, resolveMisTradePrice } from '@/lib/datasource/TWSERealtime';
import { assessQuoteFreshness, type QuoteFreshnessStatus } from '@/lib/datasource/quoteFreshness';

// mis.twse 需要 Referer=fibest.jsp，否則 WAF 回空 msgArray（2026-04-21）
const MIS_HEADERS: Record<string, string> = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Referer': 'https://mis.twse.com.tw/stock/fibest.jsp',
  'Accept': 'application/json, text/javascript, */*; q=0.01',
  'Accept-Language': 'zh-TW,zh;q=0.9,en;q=0.8',
};

// ═══════════════════════════════════════════════════════════════════════════════
// TWSE 即時報價 API — 延遲約 5-15 秒（盤中）
// 來源：mis.twse.com.tw（證交所官方）
// ═══════════════════════════════════════════════════════════════════════════════

export interface RealtimeQuote {
  symbol: string;
  name: string;
  price: number;       // 最新成交價
  open: number;        // 開盤價
  high: number;        // 最高價
  low: number;         // 最低價
  prevClose: number;   // 昨收
  change: number;      // 漲跌
  changePct: number;   // 漲跌幅 %
  volume: number;      // 成交量（張，mis.twse.com.tw d.v 單位為張=1000股）
  time: string;        // 成交時間 HH:MM:SS
  date: string | null;
  updatedAt?: string;
  source: 'mis';
  stale: boolean;
  status: QuoteFreshnessStatus;
  staleReason?: string;
}

const realtimeQuerySchema = z.object({
  symbols: z.string().min(1),
});

export function parseRealtimeQuote(d: Record<string, string | undefined>, now = new Date()): RealtimeQuote | null {
  const symbol = d.c ?? '';
  const actualPrice = resolveMisTradePrice(d);
  const prevClose = parseMisPrice(d.y);
  const volume = parseInt(d.v?.replace(/,/g, '') || '0', 10);
  const noTrade = actualPrice <= 0
    && prevClose > 0
    && volume === 0
    && parseMisPrice(d.o) === 0
    && parseMisPrice(d.h) === 0
    && parseMisPrice(d.l) === 0;
  if (!symbol || (actualPrice <= 0 && !noTrade)) return null;
  const displayPrice = noTrade ? prevClose : actualPrice;
  const date = parseMisDate(d.d) ?? null;
  const freshness = assessQuoteFreshness('TW', date, now);
  return {
    symbol,
    name: d.n?.trim() || '',
    price: displayPrice,
    open: parseMisPrice(d.o),
    high: parseMisPrice(d.h),
    low: parseMisPrice(d.l),
    prevClose,
    change: noTrade ? 0 : (prevClose > 0 ? +(actualPrice - prevClose).toFixed(2) : 0),
    changePct: noTrade ? 0 : (prevClose > 0 ? +((actualPrice - prevClose) / prevClose * 100).toFixed(2) : 0),
    volume,
    time: d.t || '',
    date: freshness.asOf,
    updatedAt: parseMisUpdatedAt(d),
    source: 'mis',
    stale: freshness.stale,
    status: noTrade && !freshness.stale ? 'no-trade' : freshness.status,
    ...(freshness.staleReason ? { staleReason: freshness.staleReason } : {}),
  };
}

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const parsed = realtimeQuerySchema.safeParse(Object.fromEntries(searchParams));
  if (!parsed.success) {
    return apiValidationError(parsed.error);
  }
  const { symbols } = parsed.data;

  const codes = symbols.split(',').map(s => s.trim()).filter(Boolean).slice(0, 50); // 最多 50 支
  if (codes.length === 0) {
    return apiError('no valid symbols', 400);
  }

  // TWSE 格式：tse_2330.tw|tse_2317.tw|otc_6770.tw
  // 上市用 tse_，上櫃用 otc_
  // 簡單判斷：4位數字通常是上市，但也有例外。先全用 tse_ 試，失敗再用 otc_
  const exCh = codes.map(c => {
    const clean = c.replace(/\.(TW|TWO)$/i, '');
    // 如果原始 symbol 有 .TWO 後綴，用 otc
    if (c.toUpperCase().includes('.TWO') || c.toUpperCase().includes('TWO')) {
      return `otc_${clean}.tw`;
    }
    return `tse_${clean}.tw`;
  }).join('|');

  try {
    const url = `https://mis.twse.com.tw/stock/api/getStockInfo.jsp?ex_ch=${exCh}&json=1&delay=0&_=${Date.now()}`;
    const res = await fetch(url, {
      headers: MIS_HEADERS,
      signal: AbortSignal.timeout(10000),
    });
    const json = await res.json();

    const quotes: RealtimeQuote[] = [];
    for (const d of json?.msgArray ?? []) {
      const quote = parseRealtimeQuote(d);
      if (quote) quotes.push(quote);
    }

    // 如果有些股票用 tse_ 查不到，可能是上櫃股，用 otc_ 重試
    const found = new Set(quotes.map(q => q.symbol));
    const missing = codes.filter(c => !found.has(c.replace(/\.(TW|TWO)$/i, '')));

    if (missing.length > 0) {
      const otcExCh = missing.map(c => `otc_${c.replace(/\.(TW|TWO)$/i, '')}.tw`).join('|');
      try {
        const otcRes = await fetch(`https://mis.twse.com.tw/stock/api/getStockInfo.jsp?ex_ch=${otcExCh}&json=1&delay=0&_=${Date.now()}`, {
          headers: MIS_HEADERS,
          signal: AbortSignal.timeout(8000),
        });
        const otcJson = await otcRes.json();
        for (const d of otcJson?.msgArray ?? []) {
          const quote = parseRealtimeQuote(d);
          if (quote && !quotes.some(item => item.symbol === quote.symbol)) quotes.push(quote);
        }
      } catch { /* OTC retry failed, skip */ }
    }

    const missingSymbols = codes.filter(code => !quotes.some(quote => quote.symbol === code.replace(/\.(TW|TWO)$/i, '')));
    return apiOk(
      { count: quotes.length, quotes, missingSymbols, status: missingSymbols.length > 0 || quotes.some(q => q.stale) ? 'degraded' : 'fresh' },
      { headers: { 'Cache-Control': 'no-store, no-cache, must-revalidate' } },
    );
  } catch (e) {
    return apiError(String(e));
  }
}
