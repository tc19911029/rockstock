import { NextRequest } from 'next/server';
import { z } from 'zod';
import { apiOk, apiError, apiValidationError } from '@/lib/api/response';
import { parseMisDate, parseMisPrice, parseMisUpdatedAt, resolveMisTradePrice } from '@/lib/datasource/TWSERealtime';
import { assessQuoteFreshness, type QuoteFreshnessStatus } from '@/lib/datasource/quoteFreshness';
import { assessIntradayFreshness } from '@/lib/datasource/intradayFreshness';
import { readIntradaySnapshot } from '@/lib/datasource/IntradayCache';
import { readCandleFile } from '@/lib/datasource/CandleStorageAdapter';
import { getQuoteSnapshotDate, isAfterMarketClose, isMarketOpen } from '@/lib/datasource/marketHours';
import { readTWOfficialCloseState } from '@/lib/datasource/twOfficialCloseState';

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
  source: 'mis' | 'l2' | 'l2-indicative' | 'l2-provisional-close' | 'l1' | 'l1-no-trade';
  provisional?: boolean;
  priceKind?: string;
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

  // 舊即時表格也只讀中央 L2；收盤後改讀已封存官方 L1，禁止再打單股 MIS。
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Taipei' }).format(new Date());
  const quotes: RealtimeQuote[] = [];
  if (isMarketOpen('TW')) {
    const snapshot = await readIntradaySnapshot('TW', today).catch(() => null);
    const snapshotFreshness = snapshot ? assessIntradayFreshness('TW', snapshot) : null;
    const byCode = new Map(snapshot?.quotes.map(quote => [quote.symbol, quote]) ?? []);
    for (const requested of codes) {
      const code = requested.replace(/\.(TW|TWO)$/i, '');
      const quote = byCode.get(code);
      if (!snapshot || !quote || quote.close <= 0) continue;
      const updatedAt = quote.observedAt ?? snapshot.updatedAt;
      const updated = updatedAt ? new Date(updatedAt) : null;
      quotes.push({
        symbol: code,
        name: quote.name,
        price: quote.close,
        open: quote.open,
        high: quote.high,
        low: quote.low,
        prevClose: quote.prevClose,
        change: +(quote.close - quote.prevClose).toFixed(2),
        changePct: quote.changePercent,
        volume: quote.volume,
        time: updated && Number.isFinite(updated.getTime())
          ? new Intl.DateTimeFormat('zh-TW', { timeZone: 'Asia/Taipei', hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' }).format(updated)
          : '',
        date: snapshot.date,
        updatedAt,
        source: quote.priceKind === 'indicative' ? 'l2-indicative' : 'l2',
        stale: snapshotFreshness?.stale ?? true,
        status: snapshotFreshness?.stale ? 'delayed' : 'live',
        ...(snapshotFreshness?.reason ? { staleReason: snapshotFreshness.reason } : {}),
        provisional: quote.priceKind === 'indicative',
        priceKind: quote.priceKind,
      });
    }
  } else {
    const expectedDate = getQuoteSnapshotDate('TW');
    const officialClose = await readTWOfficialCloseState(expectedDate);
    const officialNoTrade = new Set(officialClose?.noTradeSymbols ?? []);
    const postCloseSnapshot = isAfterMarketClose('TW')
      ? await readIntradaySnapshot('TW', expectedDate).catch(() => null)
      : null;
    const postCloseSnapshotFresh = postCloseSnapshot
      ? !assessIntradayFreshness('TW', postCloseSnapshot).stale
      : false;
    const byCode = new Map(postCloseSnapshot?.quotes.map(quote => [quote.symbol, quote]) ?? []);

    for (const requested of codes) {
      const code = requested.replace(/\.(TW|TWO)$/i, '');
      const candidates = [...new Set([requested, `${code}.TW`, `${code}.TWO`])];
      let l1Fallback: RealtimeQuote | null = null;
      for (const candidate of candidates) {
        const file = await readCandleFile(candidate, 'TW').catch(() => null);
        const last = file?.candles.at(-1);
        if (!last || last.close <= 0) continue;
        const freshness = assessQuoteFreshness('TW', last.date);
        const l1Quote: RealtimeQuote = {
          symbol: code,
          name: '',
          price: last.close,
          open: last.open,
          high: last.high,
          low: last.low,
          prevClose: file?.candles.at(-2)?.close ?? last.close,
          change: +((last.close) - (file?.candles.at(-2)?.close ?? last.close)).toFixed(2),
          changePct: file?.candles.at(-2)?.close
            ? +((last.close - file.candles.at(-2)!.close) / file.candles.at(-2)!.close * 100).toFixed(2)
            : 0,
          volume: last.volume,
          time: '',
          date: last.date,
          source: 'l1',
          stale: freshness.stale,
          status: freshness.status,
          ...(freshness.staleReason ? { staleReason: freshness.staleReason } : {}),
          provisional: false,
        };
        l1Fallback ??= l1Quote;
        if (last.date === expectedDate) {
          l1Fallback = l1Quote;
          break;
        }
      }

      if (l1Fallback?.date === expectedDate) {
        quotes.push(l1Fallback);
        continue;
      }

      if (l1Fallback && officialNoTrade.has(code)) {
        quotes.push({
          ...l1Fallback,
          source: 'l1-no-trade',
          stale: false,
          status: 'no-trade',
          provisional: false,
        });
        continue;
      }

      const l2 = byCode.get(code);
      if (postCloseSnapshot && postCloseSnapshotFresh && l2 && l2.close > 0) {
        const updatedAt = l2.observedAt ?? postCloseSnapshot.updatedAt;
        const updated = updatedAt ? new Date(updatedAt) : null;
        quotes.push({
          symbol: code,
          name: l2.name,
          price: l2.close,
          open: l2.open,
          high: l2.high,
          low: l2.low,
          prevClose: l2.prevClose,
          change: +(l2.close - l2.prevClose).toFixed(2),
          changePct: l2.changePercent,
          volume: l2.volume,
          time: updated && Number.isFinite(updated.getTime())
            ? new Intl.DateTimeFormat('zh-TW', { timeZone: 'Asia/Taipei', hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' }).format(updated)
            : '',
          date: postCloseSnapshot.date,
          updatedAt,
          source: 'l2-provisional-close',
          provisional: true,
          priceKind: l2.priceKind,
          stale: false,
          status: 'provisional-close',
        });
        continue;
      }

      if (l1Fallback) quotes.push(l1Fallback);
    }
  }

  const missingSymbols = codes.filter(code => !quotes.some(quote => quote.symbol === code.replace(/\.(TW|TWO)$/i, '')));
  return apiOk(
    { count: quotes.length, quotes, missingSymbols, status: missingSymbols.length > 0 || quotes.some(q => q.stale) ? 'degraded' : 'fresh' },
    { headers: { 'Cache-Control': 'no-store, no-cache, must-revalidate' } },
  );


}
