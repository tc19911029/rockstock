import { NextRequest } from 'next/server';
import { z } from 'zod';
import { apiOk, apiError } from '@/lib/api/response';
import { getEastMoneySingleQuote } from '@/lib/datasource/EastMoneyRealtime';
import { readIntradaySnapshot } from '@/lib/datasource/IntradayCache';
import { readCandleFile } from '@/lib/datasource/CandleStorageAdapter';
import { isAfterMarketClose, isCNMarketLunchBreak, isMarketOpen, isMarketPollingWindow } from '@/lib/datasource/marketHours';
import { fetchQuote } from '@/lib/cn-sanse/cnQuote';
import { fetchLiveIndexQuote, type LiveIndexSymbol } from '@/lib/datasource/IndexRealtime';
import { assessIntradayFreshness } from '@/lib/datasource/intradayFreshness';
import { assessQuoteFreshness } from '@/lib/datasource/quoteFreshness';
import { getQuoteSnapshotDate } from '@/lib/datasource/marketHours';
import { readTWOfficialCloseState } from '@/lib/datasource/twOfficialCloseState';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const schema = z.object({
  symbol: z.string().min(1),
});

function isFreshProviderQuote(
  market: 'TW' | 'CN',
  date: string | undefined,
  updatedAt: string | undefined,
  now = new Date(),
): boolean {
  if (!date || !updatedAt) return false;
  return !assessIntradayFreshness(market, { date, updatedAt, count: 1 }, now).stale;
}

/**
 * 輕量即時報價 endpoint — 走圖 polling 用，只回 OHLCV。
 * 盤中／盤後定稿期走 Fugle / MIS / L2；其餘時段只讀 L1 末根，
 * 即使舊版前台分頁還在 polling，也不會於週末／深夜空打 vendor。
 */
export async function GET(req: NextRequest) {
  const params = Object.fromEntries(req.nextUrl.searchParams);
  const parsed = schema.safeParse(params);
  if (!parsed.success) return apiError('symbol 必填', 400);

  const { symbol } = parsed.data;

  // TXF 使用期交所行情資訊網的近月即時 snapshot（日盤 08:45–13:45、夜盤 15:00–05:00）。
  // 必須早於股票市場分類；否則 TXF 既不是 4–5 位臺股代號，也不會進任何 quote provider。
  if (symbol.toUpperCase() === 'TXF') {
    try {
      const { fetchTaifexTxFuturesQuote } = await import('@/lib/datasource/TaifexFuturesProvider');
      const quote = await fetchTaifexTxFuturesQuote();
      if (!quote) return apiError('臺股期貨目前非交易時段', 404);
      return apiOk({ symbol: 'TXF', ...quote });
    } catch (error) {
      const message = error instanceof Error ? error.message : '期交所即時報價載入失敗';
      return apiError(message, 502);
    }
  }

  const pureCode = symbol.replace(/\.(TW|TWO|SS|SZ)$/i, '');
  // suffix 權威：.SS/.SZ → CN；.TW/.TWO → TW；無 suffix 用位數 fallback（4-5 位 TW、6 位 CN）
  const hasCnSuffix = /\.(SS|SZ)$/i.test(symbol);
  const hasTwSuffix = /\.(TW|TWO)$/i.test(symbol);
  // 2026-05-07：加 INDEX 路徑 — ^TWII / ^TWOII / 000001.SS / 000300.SS 等指數要走獨立路徑
  // 不能進 isCN（會被 EastMoney quote API 誤回平安銀行 000001.SZ 的價）
  const isTwIndex = symbol === '^TWII' || symbol === '^TWOII';
  const isCnIndex = symbol === '000001.SS' || symbol === '000300.SS';
  const isIndex = isTwIndex || isCnIndex;
  const isCN = !isIndex && (hasCnSuffix || (!hasTwSuffix && /^\d{6}$/.test(pureCode)));
  const isTW = !isCN && !isIndex && (hasTwSuffix || /^\d{4,5}[A-Za-z]?$/.test(pureCode));
  const market = isCnIndex ? 'CN' : (isTwIndex ? 'TW' : (isCN ? 'CN' : (isTW ? 'TW' : null)));

  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Taipei' }).format(new Date());

  // Server-side defense in depth: 新版前台會在休市時停止 timer，但部署前已開啟的
  // 舊分頁可能繼續每 30 秒呼叫。路由層仍要擋住，避免 MIS/Fugle 被無效輪詢放大。
  const cnLunchBreak = market === 'CN' && isCNMarketLunchBreak();
  const liveQuoteWindow = market === 'TW'
    ? isMarketOpen('TW')
    : (market ? isMarketPollingWindow(market) || cnLunchBreak : false);
  if (market && !liveQuoteWindow) {
    const expectedDate = getQuoteSnapshotDate(market);
    const suffix = market === 'TW'
      ? (/\.TWO$/i.test(symbol) ? 'TWO' : 'TW')
      : (/\.SS$/i.test(symbol) || (!/\.SZ$/i.test(symbol) && /^[69]/.test(pureCode)) ? 'SS' : 'SZ');
    const candidates = isIndex
      ? [symbol]
      : market === 'TW'
        ? [...new Set([symbol, `${pureCode}.${suffix}`, `${pureCode}.TW`, `${pureCode}.TWO`])]
        : [...new Set([symbol, `${pureCode}.${suffix}`])];

    let l1Fallback: { date: string; open: number; high: number; low: number; close: number; volume: number } | null = null;
    for (const candidate of candidates) {
      try {
        const file = await readCandleFile(candidate, market);
        const last = file?.candles.at(-1);
        if (last && last.close > 0) {
          l1Fallback ??= {
            date: last.date,
            open: last.open,
            high: last.high,
            low: last.low,
            close: last.close,
            volume: last.volume,
          };
          // 正式日線已到今天就直接採用；不用再讀 L2。
          if (last.date === expectedDate) {
            return apiOk({
              symbol,
              date: last.date,
              open: last.open,
              high: last.high,
              low: last.low,
              close: last.close,
              volume: last.volume,
              source: 'l1',
              stale: false,
            }, { headers: { 'Cache-Control': 'no-store, no-cache, must-revalidate' } });
          }
        }
      } catch { /* try next suffix */ }
    }

    if (market === 'TW' && isAfterMarketClose('TW') && l1Fallback) {
      const officialClose = await readTWOfficialCloseState(expectedDate);
      if (officialClose?.noTradeSymbols.includes(pureCode)) {
        return apiOk({
          symbol,
          ...l1Fallback,
          source: 'l1-no-trade',
          status: 'no-trade',
          provisional: false,
          stale: false,
          marketSession: 'closed',
          noTradeReason: '官方收盤表確認今日無成交，顯示最近一次真實成交價',
        }, { headers: { 'Cache-Control': 'no-store, no-cache, must-revalidate' } });
      }
    }

    // 台股收盤後、官方 L1 尚未發布的過渡期，先顯示中央 L2 收盤定格值。
    // 這個值只標 provisional-close、不寫入 L1；一旦上方找到今日 L1，永遠由 L1 優先返回。
    if (market === 'TW' && isAfterMarketClose('TW')) {
      try {
        const snapshot = await readIntradaySnapshot('TW', expectedDate);
        const snapshotFreshness = snapshot ? assessIntradayFreshness('TW', snapshot) : null;
        const l2 = snapshot?.quotes.find(item => item.symbol === pureCode);
        if (snapshot && !snapshotFreshness?.stale && l2 && l2.close > 0) {
          return apiOk({
            symbol,
            date: snapshot.date,
            open: l2.open,
            high: l2.high,
            low: l2.low,
            close: l2.close,
            volume: l2.volume,
            source: 'l2-provisional-close',
            updatedAt: l2.observedAt ?? snapshot.updatedAt,
            priceKind: l2.priceKind,
            provisional: true,
            marketSession: 'post_close_pending_official',
            stale: false,
            status: 'provisional-close',
          }, { headers: { 'Cache-Control': 'no-store, no-cache, must-revalidate' } });
        }
      } catch { /* L2 不可用時保留下方舊 L1 delayed fallback */ }
    }

    if (l1Fallback) {
      const freshness = assessQuoteFreshness(market, l1Fallback.date);
      return apiOk({
        symbol,
        ...l1Fallback,
        source: 'l1',
        stale: freshness.stale,
        status: freshness.status,
        ...(freshness.staleReason ? { staleReason: freshness.staleReason } : {}),
      }, { headers: { 'Cache-Control': 'no-store, no-cache, must-revalidate' } });
    }
    return apiError(`無法取得 ${symbol} 報價`, 404);
  }

  let quote: { open: number; high: number; low: number; close: number; volume: number } | null = null;
  let quoteDate: string | null = null;
  let quoteSource: string | undefined;
  let quoteUpdatedAt: string | undefined;
  let quotePriceKind: string | undefined;
  let provisional = false;
  let stale = false;

  // ── INDEX 走獨立即時鏈，最後才接受通過新鮮度檢查的 L2 ──
  // 過去每 30 秒 polling 都先命中 5 分鐘 L2，造成「前端很勤、數字仍慢 2–5 分鐘」；
  // L2 凍結時更會一直回同一筆舊數字。現在 TW 走 Fugle/MIS、CN 走 Tencent 單檔。
  if (isIndex) {
    try {
      const iq = await fetchLiveIndexQuote(symbol as LiveIndexSymbol, today);
      if (iq && iq.close > 0) {
        quote = { open: iq.open, high: iq.high, low: iq.low, close: iq.close, volume: iq.volume };
        quoteDate = iq.date;
        quoteSource = iq.source;
        quoteUpdatedAt = iq.updatedAt;
      }
    } catch { /* fallthrough */ }
  }

  // ── TW ──
  if (isTW) {
    // 所有台股盤中畫面只讀每分鐘中央快照，不另打 MIS／Fugle。
    try {
      const snapshot = await readIntradaySnapshot('TW', today);
      const q = snapshot?.quotes.find(item => item.symbol === pureCode);
      if (snapshot && q && q.close > 0 && !assessIntradayFreshness('TW', snapshot).stale) {
        quote = { open: q.open, high: q.high, low: q.low, close: q.close, volume: q.volume };
        quoteDate = snapshot.date;
        quoteSource = q.priceKind === 'indicative' ? 'l2-indicative' : 'l2';
        quoteUpdatedAt = q.observedAt ?? snapshot.updatedAt;
        quotePriceKind = q.priceKind;
        provisional = q.priceKind === 'indicative';
      }
    } catch { /* fallthrough */ }
  }

  // ── CN ──
  if (isCN && !cnLunchBreak) {
    // suffix：明示優先；裸碼用首位推（6/9→上海 SS、其餘→深圳 SZ）。
    const cnSuffix: 'SS' | 'SZ' = /\.SS$/i.test(symbol) ? 'SS' : /\.SZ$/i.test(symbol) ? 'SZ'
      : (/^[69]/.test(pureCode) ? 'SS' : 'SZ');

    // 1) 主源騰訊 qt.gtimg.cn — 與 CN K 線同源、穩定（EastMoney push2 部分環境常 502）。
    //    F2 修正：原本只走 EastMoney 單次、無重試/fallback → 間歇 404「無法取得報價」。
    try {
      const tq = await fetchQuote(`${pureCode}.${cnSuffix}`);
      if (
        tq && tq.price > 0 && tq.open > 0 && tq.high > 0 && tq.low > 0
        && tq.date === today && isFreshProviderQuote('CN', tq.date, tq.updatedAt)
      ) {
        // 騰訊量單位「手」、CN L1 基準「股」→ ×100 對齊
        quote = { open: tq.open, high: tq.high, low: tq.low, close: tq.price, volume: tq.volumeLots * 100 };
        quoteDate = tq.date;
        quoteSource = 'tencent';
        quoteUpdatedAt = tq.updatedAt;
      }
    } catch { /* fallthrough */ }

    // 2) fallback EastMoney push2
    if (!quote) {
      try {
        const q = await getEastMoneySingleQuote(pureCode, cnSuffix);
        if (q && q.close > 0 && q.date === today && isFreshProviderQuote('CN', q.date, q.updatedAt)) {
          quote = { open: q.open, high: q.high, low: q.low, close: q.close, volume: q.volume };
          quoteDate = q.date;
          quoteSource = 'eastmoney';
          quoteUpdatedAt = q.updatedAt;
        }
      } catch { /* fallthrough */ }
    }
  }

  // ── L2 fallback（指數要排除，避免 pureCode='000001' 撞到深圳平安銀行 SZ）──
  if (!quote && market && !isIndex) {
    try {
      const snapshot = await readIntradaySnapshot(market as 'TW' | 'CN', today);
      const sq = snapshot?.quotes.find(q => q.symbol === pureCode);
      const freshSnapshot = snapshot
        ? !assessIntradayFreshness(market, snapshot).stale
        : false;
      if (freshSnapshot && sq && sq.close > 0) {
        quote = { open: sq.open, high: sq.high, low: sq.low, close: sq.close, volume: sq.volume };
        quoteDate = snapshot!.date;
        quoteSource = sq.priceKind === 'indicative' ? 'l2-indicative' : 'l2';
        quoteUpdatedAt = sq.observedAt ?? snapshot!.updatedAt;
        quotePriceKind = sq.priceKind;
        provisional = market === 'TW' && sq.priceKind === 'indicative';
      }
    } catch { /* fallthrough */ }
  }

  // ── INDEX fallback：讀 L1 末根（L2 / MIS 沒抓到，給最後一個交易日的值墊著）
  // 2026-05-07：原本指數走 quote API 永遠 404 → 走圖 polling 失敗，盤中不更新。
  // 2026-05-26：回傳真實 last.date 而不是強制 today，讓 polling 端能比對「這是舊資料」拒絕覆寫。
  if (!quote && (isTwIndex || isCnIndex)) {
    try {
      const f = await readCandleFile(symbol, market as 'TW' | 'CN');
      const last = f?.candles[f.candles.length - 1];
      if (last && last.close > 0) {
        quote = { open: last.open, high: last.high, low: last.low, close: last.close, volume: last.volume };
        quoteDate = last.date;
        quoteSource = 'l1';
        stale = true;
      }
    } catch { /* fallthrough */ }
  }

  if (!quote) return apiError(`無法取得 ${symbol} 報價`, 404);

  const freshness = market ? assessQuoteFreshness(market, quoteDate) : null;
  stale ||= freshness?.stale ?? false;
  return apiOk({
    symbol,
    date: quoteDate,
    ...quote,
    source: quoteSource,
    updatedAt: quoteUpdatedAt,
    priceKind: quotePriceKind,
    provisional,
    ...(cnLunchBreak ? { marketSession: 'lunch_break' as const } : {}),
    stale,
    status: freshness?.status,
    ...(freshness?.staleReason ? { staleReason: freshness.staleReason } : {}),
  }, { headers: { 'Cache-Control': 'no-store, no-cache, must-revalidate' } });
}
