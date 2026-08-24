import { NextRequest } from 'next/server';
import { z } from 'zod';
import { apiOk, apiError } from '@/lib/api/response';
import { getFugleQuote, isFugleAvailable } from '@/lib/datasource/FugleProvider';
import { getTWSESingleIntraday } from '@/lib/datasource/TWSERealtime';
import { getEastMoneySingleQuote } from '@/lib/datasource/EastMoneyRealtime';
import { readIntradaySnapshot } from '@/lib/datasource/IntradayCache';
import { readCandleFile } from '@/lib/datasource/CandleStorageAdapter';
import { isMarketPollingWindow } from '@/lib/datasource/marketHours';
import { fetchQuote } from '@/lib/cn-sanse/cnQuote';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const schema = z.object({
  symbol: z.string().min(1),
});

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
  if (market && !isMarketPollingWindow(market)) {
    const suffix = market === 'TW'
      ? (/\.TWO$/i.test(symbol) ? 'TWO' : 'TW')
      : (/\.SS$/i.test(symbol) || (!/\.SZ$/i.test(symbol) && /^[69]/.test(pureCode)) ? 'SS' : 'SZ');
    const candidates = isIndex
      ? [symbol]
      : market === 'TW'
        ? [...new Set([symbol, `${pureCode}.${suffix}`, `${pureCode}.TW`, `${pureCode}.TWO`])]
        : [...new Set([symbol, `${pureCode}.${suffix}`])];

    for (const candidate of candidates) {
      try {
        const file = await readCandleFile(candidate, market);
        const last = file?.candles.at(-1);
        if (last && last.close > 0) {
          return apiOk({ symbol, date: last.date, open: last.open, high: last.high, low: last.low, close: last.close, volume: last.volume });
        }
      } catch { /* try next suffix */ }
    }
    return apiError(`無法取得 ${symbol} 報價`, 404);
  }

  let quote: { open: number; high: number; low: number; close: number; volume: number } | null = null;
  let quoteDate: string = today;  // 預設 today（live quote 路徑）；L1 fallback 會改成真實 last.date

  // ── INDEX 優先走 L2 snapshot（mis.twse 抓的 ^TWII / 000001.SS 真實當日 quote）──
  // 個股不能進這條（pureCode='000001' 會撞到深圳平安銀行 SZ），但 INDEX 在 snapshot
  // 內 symbol 帶 '^' / '.SS' 前後綴，不會與個股相撞。
  // 修這條的原因：原本 INDEX 直接走最下面「L1 末根」fallback，回的是「昨天的 K + 強制 today 的 date」，
  // polling 端拿到後會用 Math.max(high)/Math.min(low) 把已經正確的今日 bar 蓋成「昨天 OHLCV + 今日 high」
  // 詭異混合（chg 變 0%）。L2 snapshot 內已有 INDEX 即時 quote，優先用它。
  if (isIndex && market) {
    try {
      const snapshot = await readIntradaySnapshot(market as 'TW' | 'CN', today);
      const sq = snapshot?.quotes.find(q => q.symbol === symbol);  // INDEX 用完整 symbol 比對（^TWII / 000001.SS）
      if (sq && sq.close > 0 && (market !== 'TW' || sq.isActualTrade !== false)) {
        quote = { open: sq.open, high: sq.high, low: sq.low, close: sq.close, volume: sq.volume };
      }
    } catch { /* fallthrough */ }
  }

  // TW 指數快照缺漏時直接補打 MIS（^TWII=t00、^TWOII=o00），再退 L1。
  if (!quote && isTwIndex) {
    try {
      const { fetchTWIndexQuote } = await import('@/lib/datasource/IntradayCache');
      const iq = await fetchTWIndexQuote(today, symbol as '^TWII' | '^TWOII');
      if (iq && iq.close > 0) {
        quote = { open: iq.open, high: iq.high, low: iq.low, close: iq.close, volume: iq.volume };
      }
    } catch { /* fallthrough */ }
  }

  // ── TW ──
  if (isTW) {
    // 1) MIS 單股即時
    try {
      const q = await getTWSESingleIntraday(pureCode);
      if (q && q.close > 0 && (!q.date || q.date === today)) {
        quote = { open: q.open, high: q.high, low: q.low, close: q.close, volume: q.volume };
        quoteDate = q.date ?? today;
      }
    } catch { /* fallthrough */ }

    // 2) Fugle
    if (!quote && isFugleAvailable()) {
      try {
        const fq = await getFugleQuote(pureCode);
        if (fq && fq.close > 0) {
          quote = { open: fq.open || fq.close, high: fq.high || fq.close, low: fq.low || fq.close, close: fq.close, volume: fq.volume };
          quoteDate = fq.date ?? today;
        }
      } catch { /* fallthrough */ }
    }
  }

  // ── CN ──
  if (isCN) {
    // suffix：明示優先；裸碼用首位推（6/9→上海 SS、其餘→深圳 SZ）。
    const cnSuffix: 'SS' | 'SZ' = /\.SS$/i.test(symbol) ? 'SS' : /\.SZ$/i.test(symbol) ? 'SZ'
      : (/^[69]/.test(pureCode) ? 'SS' : 'SZ');

    // 1) 主源騰訊 qt.gtimg.cn — 與 CN K 線同源、穩定（EastMoney push2 部分環境常 502）。
    //    F2 修正：原本只走 EastMoney 單次、無重試/fallback → 間歇 404「無法取得報價」。
    try {
      const tq = await fetchQuote(`${pureCode}.${cnSuffix}`);
      if (tq && tq.price > 0 && tq.open > 0 && tq.high > 0 && tq.low > 0) {
        // 騰訊量單位「手」、CN L1 基準「股」→ ×100 對齊
        quote = { open: tq.open, high: tq.high, low: tq.low, close: tq.price, volume: tq.volumeLots * 100 };
        quoteDate = tq.date ?? today;
      }
    } catch { /* fallthrough */ }

    // 2) fallback EastMoney push2
    if (!quote) {
      try {
        const q = await getEastMoneySingleQuote(pureCode, cnSuffix);
        if (q && q.close > 0) {
          quote = { open: q.open, high: q.high, low: q.low, close: q.close, volume: q.volume };
          quoteDate = q.date ?? today;
        }
      } catch { /* fallthrough */ }
    }
  }

  // ── L2 fallback（指數要排除，避免 pureCode='000001' 撞到深圳平安銀行 SZ）──
  if (!quote && market && !isIndex) {
    try {
      const snapshot = await readIntradaySnapshot(market as 'TW' | 'CN', today);
      const sq = snapshot?.quotes.find(q => q.symbol === pureCode);
      if (sq && sq.close > 0 && (market !== 'TW' || sq.isActualTrade !== false)) {
        quote = { open: sq.open, high: sq.high, low: sq.low, close: sq.close, volume: sq.volume };
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
      }
    } catch { /* fallthrough */ }
  }

  if (!quote) return apiError(`無法取得 ${symbol} 報價`, 404);

  return apiOk({ symbol, date: quoteDate, ...quote });
}
