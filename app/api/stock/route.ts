import { NextRequest } from 'next/server';
import { z } from 'zod';
import { twNameWithTimeout, cnNameWithTimeout } from '@/lib/datasource/nameWithTimeout';
import { dataProvider } from '@/lib/datasource/MultiMarketProvider';
import { getFugleIntradayCandles, getFugleHistoricalMinuteCandles, isFugleAvailable } from '@/lib/datasource/FugleProvider';
import { loadLocalCandlesWithTolerance } from '@/lib/datasource/LocalCandleStore';
import { aggregateCandles } from '@/lib/datasource/aggregateCandles';
import { computeIndicators } from '@/lib/indicators';
import { apiOk, apiError, apiValidationError } from '@/lib/api/response';
import { getEastMoneySingleQuote } from '@/lib/datasource/EastMoneyRealtime';
import { readIntradaySnapshot } from '@/lib/datasource/IntradayCache';
import { fetchLiveIndexQuote, type LiveIndexSymbol } from '@/lib/datasource/IndexRealtime';
import { checkQuoteSanity } from '@/lib/datasource/QuoteSanityCheck';
import { isCNMarketLunchBreak, isMarketOpen } from '@/lib/datasource/marketHours';
import { assessIntradayFreshness } from '@/lib/datasource/intradayFreshness';
import { isFundSymbol } from '@/lib/market/classify';
import type { Candle } from '@/types';
import { promises as fsp } from 'node:fs';
import path from 'node:path';

// ── Route segment config（2026-06-08 冷啟動止血）─────────────────────────────
// 走圖主資料路由：用 fs/Blob → 必須 Node runtime；force-dynamic 確保永遠讀即時資料、
// 不被靜態快取；maxDuration 給冷啟動上限保護，避免慢冷啟動被 gateway 砍成 504。
// 用 120（非 60）：現行 production 無 maxDuration 時冷啟動實測 ~65s 才回 200（方案上限 ≥64s），
// 設 60 反而會把「慢但成功」變成 504 regression；120 是安全屋簷、又在 Pro/Fluid 上限內。
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 120;

// ── best-effort 外部呼叫總時間預算：逾時/失敗回 fallback，永不 reject ──────────
// 用於「今日 K 棒注入」這種 nice-to-have 的即時報價鏈。冷啟動時 TWSE/EastMoney/Fugle/L2
// 連線全冷會逐段累加卡死整個 /api/stock（曾見 ~65s 冷啟動）→ 逾時就放棄今日那根、直接
// 回封存日K（圖照樣秒開，最多少今天那根即時 bar）。
function withTimeout<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  return new Promise<T>((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) { settled = true; resolve(fallback); }
    }, ms);
    p.then(
      (v) => { if (!settled) { settled = true; clearTimeout(timer); resolve(v); } },
      () => { if (!settled) { settled = true; clearTimeout(timer); resolve(fallback); } },
    );
  });
}

function isFreshProviderQuote(
  market: 'TW' | 'CN',
  date: string | undefined,
  updatedAt: string | undefined,
): boolean {
  if (!date || !updatedAt) return false;
  return !assessIntradayFreshness(market, { date, updatedAt, count: 1 }).stale;
}

// ── 中文名稱查詢（local 與 API 兩條路徑共用唯一一份，防 timeout 包覆 drift）──────────
// 名稱是 nice-to-have：buildNameMap 冷啟動要打 TWSE/TPEx/ISIN 三源、CN 走 EastMoney/騰訊，
// fake-IP DNS 下 Node fetch 會卡數十秒。設 3s 預算，逾時就回 null（呼叫端用代號當名稱），
// 圖照樣秒出、name-map 之後在背景建好、下次就有名。曾因兩條路徑各自包覆、只改一條而 regress。
async function resolveChineseName(opts: { isTW: boolean; isCN: boolean; pureCode: string; symbol: string }): Promise<string | null> {
  const { isTW, isCN, pureCode, symbol } = opts;
  if (isTW) return await twNameWithTimeout(pureCode);
  if (isCN) {
    const cnSuffix = /\.SS$/i.test(symbol) ? 'SS' : /\.SZ$/i.test(symbol) ? 'SZ' : undefined;
    return await cnNameWithTimeout(pureCode, cnSuffix);
  }
  return null;
}

// ── 場外基金(.OF) K 線：讀 data/funds/{symbol}.json（淨值歷史，與股票 L1 隔離）──────────
//   基金一天只有一個單位淨值 → 退化 K 棒 O=H=L=C=NAV、volume=0。資料由
//   scripts/fetch-fund-candles.ts 預抓寫入；本路徑只讀檔 + 依 interval 聚合 + 切 period。
function fundPeriodToDays(period: string): number {
  const m = period.match(/^(\d+)(y|mo|d)$/);
  if (!m) return 730;
  const n = parseInt(m[1], 10);
  return m[2] === 'y' ? n * 365 : m[2] === 'mo' ? n * 31 : n;
}

interface FundCandleFile { symbol: string; name: string; lastDate: string; candles: Candle[] }

async function handleFundChart(symbol: string, interval: string, period: string) {
  if (!/^\d{6}\.OF$/i.test(symbol)) return apiError(`不支援的基金代號：${symbol}`, 400);
  if (['1m', '5m', '15m', '30m', '60m'].includes(interval)) {
    return apiError(`場外基金 ${symbol} 無分鐘 K（一日一淨值）`, 404);
  }
  let file: FundCandleFile;
  try {
    file = JSON.parse(await fsp.readFile(path.join(process.cwd(), 'data', 'funds', `${symbol.toUpperCase()}.json`), 'utf-8'));
  } catch {
    return apiError(`基金 ${symbol} 尚無淨值資料，請先跑 scripts/fetch-fund-candles.ts`, 404);
  }
  const cutoff = new Date(Date.now() - fundPeriodToDays(period) * 86400000)
    .toLocaleDateString('en-CA', { timeZone: 'Asia/Shanghai' });
  const daily = (file.candles ?? []).filter(c => c.date >= cutoff);
  const candles = interval === '1d' ? daily : aggregateCandles(daily, interval);
  if (candles.length === 0) return apiError(`基金 ${symbol} 無 ${period} 區間淨值`, 404);
  return apiOk({
    ticker: file.symbol,
    name: file.name,
    currency: 'CNY',
    interval,
    candles: candles.map(c => ({ date: c.date, open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume })),
    totalBars: candles.length,
    source: 'fund-nav',
  });
}

// ── 週K/月K 聚合結果快取（避免重複聚合 + computeIndicators） ──
const aggregateCache = new Map<string, { data: unknown; expires: number }>();
const AGGREGATE_CACHE_TTL = 5 * 60 * 1000; // 5 分鐘

/**
 * API Route: /api/stock?symbol=2330&interval=1d&period=2y
 *
 * 使用 MultiMarketProvider 多源備援：
 *   台股 → FinMind → TWSE/TPEx（備援）+ TWSE 即時覆蓋
 *   陸股 → 騰訊 → 東方財富（備援）+ 東方財富即時覆蓋
 *   美股 → 騰訊 → 東方財富（備援）+ 東方財富即時覆蓋
 *
 * interval: 1d (日K) | 1wk (週K) | 1mo (月K)
 * period:   1y | 2y | 3y | 5y | 10y
 */

const stockQuerySchema = z.object({
  symbol:   z.string().min(1),
  interval: z.enum(['1m', '5m', '15m', '30m', '60m', '1d', '1wk', '1mo']).default('1d'),
  period:   z.string().default('2y'),
  local:    z.enum(['1', '0']).optional(), // '1' = 本地檔案優先（日K混合模式用）
  scanDate: z.string().optional(),         // 'YYYY-MM-DD' 掃描日期，若 L1 缺該日則從 L2 快照補入
});

const INDEX_NAMES: Record<string, string> = {
  '^TWII': '台灣加權指數',
  '^TWOII': '櫃買指數',
  '^000001': '上證指數',
};

/** 解析 symbol 並加上交易所後綴 */
function resolveSymbol(symbol: string): { ticker: string; candidates: string[]; isTW: boolean; isCN: boolean } {
  // 指數 symbols：走本地檔案路徑（與一般個股共用 loadLocalCandlesWithTolerance）
  // TW 指數：^TWII（加權指數）、^TWOII（櫃買指數）
  // CN 指數：000001.SS（上證指數）、000300.SS（滬深 300）
  // 注意：000001.SS 必須優先匹配為 CN 指數，避免被 /^\d{6}\.(SZ|SS)$/ 一般 CN 路徑搶走後加錯 fallback
  if (symbol === '^TWII' || symbol === '^TWOII') {
    return { ticker: symbol, candidates: [symbol], isTW: true, isCN: false };
  }
  if (/^\d{6}\.SS$/i.test(symbol) && (symbol.startsWith('000001') || symbol.startsWith('000300'))) {
    const upper = symbol.toUpperCase();
    return { ticker: upper, candidates: [upper], isTW: false, isCN: true };
  }

  const isTW = /^\d{4,5}[A-Za-z]?$/.test(symbol) || /^\d{4,5}[A-Za-z]?\.(TW|TWO)$/i.test(symbol);
  const isCN = /^\d{6}$/.test(symbol) || /^\d{6}\.(SZ|SS)$/i.test(symbol);
  const pureCode = symbol.replace(/\.(SZ|SS|TW|TWO)$/i, '');

  let candidates: string[];
  if (isCN) {
    // CN 不加 fallback：000001.SS（上證指數）vs 000001.SZ（平安銀行）是完全不同股票，
    // 跨後綴 fallback 會誤抓別人的資料。SS/SZ 是獨立代碼空間。
    if (/\.(SZ|SS)$/i.test(symbol)) {
      candidates = [symbol.toUpperCase()];
    } else {
      candidates = pureCode[0] === '6' || pureCode[0] === '9'
        ? [`${pureCode}.SS`, `${pureCode}.SZ`]
        : [`${pureCode}.SZ`, `${pureCode}.SS`];
    }
  } else if (isTW) {
    // 即使指定了 .TW/.TWO 後綴，也加另一個變體當 fallback：
    // 上市/上櫃股票代號相同（如 6187 上櫃存於 6187.TWO.json），用戶或 client 帶錯後綴
    // 不應該讓本地 L1 路徑直接 miss 然後 fallthrough 去打外部 API（會拿到不一致的數字）
    if (/\.TWO$/i.test(symbol)) {
      candidates = [`${pureCode}.TWO`, `${pureCode}.TW`];
    } else if (/\.TW$/i.test(symbol)) {
      candidates = [`${pureCode}.TW`, `${pureCode}.TWO`];
    } else {
      candidates = [`${pureCode}.TW`, `${pureCode}.TWO`];
    }
  } else {
    candidates = [symbol.toUpperCase()];
  }

  return { ticker: candidates[0], candidates, isTW, isCN };
}

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const parsed = stockQuerySchema.safeParse(Object.fromEntries(searchParams));
  if (!parsed.success) {
    return apiValidationError(parsed.error);
  }
  const { symbol, interval, period, local: localParam, scanDate } = parsed.data;

  // 場外基金(.OF)：走獨立淨值資料路徑（早 return，不進股票 provider / L1 邏輯）
  if (isFundSymbol(symbol)) {
    return handleFundChart(symbol, interval, period);
  }

  // 臺股期貨近月連續線：使用期交所官方 TX 日行情，不把 TXF 誤當成美股代號。
  if (symbol.toUpperCase() === 'TXF') {
    if (['1m', '5m', '15m', '30m', '60m'].includes(interval)) {
      return apiError('臺股期貨 TXF 暫無分鐘 K 資料', 404);
    }
    try {
      const { fetchTaifexTxFuturesCandles, fetchTaifexTxFuturesQuote } = await import('@/lib/datasource/TaifexFuturesProvider');
      const [history, liveQuote] = await Promise.all([
        fetchTaifexTxFuturesCandles(scanDate),
        scanDate ? Promise.resolve(null) : withTimeout(fetchTaifexTxFuturesQuote(), 3500, null),
      ]);
      const daily = history.map((candle) => ({ ...candle }));
      if (liveQuote) {
        const last = daily.at(-1);
        const liveBar = {
          date: liveQuote.date,
          open: liveQuote.open,
          high: liveQuote.high,
          low: liveQuote.low,
          close: liveQuote.close,
          volume: liveQuote.volume,
        };
        if (last?.date === liveBar.date) daily[daily.length - 1] = liveBar;
        else if (!last || last.date < liveBar.date) daily.push(liveBar);
      }
      const candles = interval === '1d' ? daily : aggregateCandles(daily, interval);
      return apiOk({
        ticker: 'TXF',
        name: '臺灣加權期貨',
        currency: 'TWD',
        interval,
        candles,
        totalBars: candles.length,
        source: liveQuote ? 'taifex-live' : 'taifex',
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : '期交所資料載入失敗';
      return apiError(message, 502);
    }
  }

  const { candidates, isTW, isCN } = resolveSymbol(symbol);
  const pureCode = symbol.replace(/\.(SZ|SS|TW|TWO)$/i, '');
  // CN 指數（000001.SS 上證 / 000300.SS 滬深300）：pureCode='000001'/'000300' 會撞到深市
  // 平安銀行(000001.SZ) 等同碼個股 → L2 快照比對必須用完整 symbol，且不可走 EastMoney 個股報價
  // （它對指數會誤回平安銀行的價，~10.83）。對齊 /api/stock/quote 的指數處理。
  const isCnIndex = symbol === '000001.SS' || symbol === '000300.SS';
  const isTwIndex = symbol === '^TWII' || symbol === '^TWOII';
  const cnLunchBreak = (isCN || isCnIndex) && isCNMarketLunchBreak();
  const l2LookupSymbol = isCnIndex ? symbol : pureCode;

  const isMinuteInterval = ['1m', '5m', '15m', '30m', '60m'].includes(interval);

  // 陸股指數無可靠分鐘 K 資料源：000001.SS/000300.SS 去後綴後的裸碼會撞同碼個股
  // （000001→平安銀行）→ 任何分鐘 provider 都會回錯股的 K。寧可回 404 也不顯示錯資料。
  if (isCnIndex && isMinuteInterval) {
    return apiError(`陸股指數 ${symbol} 暫無分鐘 K 資料`, 404);
  }

  // ── 本地檔案快速路徑（先讀本地秒開 → 即時覆蓋今日 K） ──
  // 支援日K(1d)直接使用，以及週K(1wk)/月K(1mo)本地聚合
  if (localParam === '1' && !isMinuteInterval && (isTW || isCN)) {
    try {
      const market = isTW ? 'TW' as const : 'CN' as const;
      const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Taipei' }).format(new Date());
      // 容忍 5 個交易日差距（涵蓋週末 + 假日）
      // 遍歷所有候選（如 2330.TW → 2330.TWO），避免只試第一個就 fallthrough 到 API
      let result: Awaited<ReturnType<typeof loadLocalCandlesWithTolerance>> = null;
      // 記住「實際載到資料」的那個候選 —— 上櫃股(.TWO)用裸碼進來時 candidates[0] 是 .TW，
      // 但資料在 .TWO；回傳 ticker 必須是真正命中的候選，否則 currentStock.ticker 標錯後綴，
      // 下游(三色 overlay /chart/{ticker}、籌碼/基本面面板)會用錯後綴打 API 而失敗。
      let loadedTicker = candidates[0];
      for (const candidate of candidates) {
        result = await loadLocalCandlesWithTolerance(candidate, market, today, 5);
        if (result && result.candles.length > 0) { loadedTicker = candidate; break; }
      }
      if (result && result.candles.length > 0) {
        // ── 盤中即時覆蓋：若 lastDate < today，主動拉即時報價湊今日 K 棒 ──
        // 盤中/盤後窗口：可用即時 API 拉；窗口外（晚上/凌晨）：只靠 L2 快照（若有今日數據也允許注入）
        // 避免凌晨用舊 API 產生假的今日 K 棒，但 L2 有當日 snapshot 時就允許
        const marketKey = isTW ? 'TW' as const : 'CN' as const;
        // 台股只有盤中才注入 L2 暫時價；收盤後必須等待官方 L1，不能再把 MIS/L2 冒充收盤。
        const inLiveWindow = isMarketOpen(marketKey);
        let l2HasToday = false;
        if (!inLiveWindow && !isTW) {
          try {
            const snap = await readIntradaySnapshot(marketKey, today);
            l2HasToday = !!snap && !assessIntradayFreshness(marketKey, snap).stale && snap.quotes.some(q =>
              q.symbol === l2LookupSymbol && q.close > 0
            );
          } catch { /* ignore */ }
        }
        const lastCandle = result.candles[result.candles.length - 1];
        const shouldInjectToday = inLiveWindow || (!isTW && l2HasToday);
        // 注入條件：
        //   a) lastCandle.date < today → append 今日 K（正常路徑）
        //   b) lastCandle.date === today → 覆蓋（append-today 腳本寫進 L1 的盤中快照價，需用即時報價刷新）
        const lastIsToday = !!lastCandle && lastCandle.date === today;
        if (shouldInjectToday && lastCandle && (lastCandle.date < today || lastIsToday)) {
          let todayQuote: { open: number; high: number; low: number; close: number; volume: number } | null = null;
          // 冷啟動止血（2026-06-08）：今日即時報價整條外部 fallback 鏈設總時間預算，
          // 逾時放棄今日 bar、直接回封存日K（圖秒開）。避免冷啟動連線全冷時逐段累加卡死。
          const INJECT_BUDGET_MS = Number(process.env.STOCK_INJECT_BUDGET_MS) || 3500;
          const injectDeadline = Date.now() + INJECT_BUDGET_MS;
          try {
            if (isTwIndex || isCnIndex) {
              // 指數用獨立單檔即時鏈；不讓 5 分鐘 L2 先攔截 30 秒走圖 polling。
              // helper 已自帶「只有新鮮 L2 才可 fallback」的守門。
              const iq = await withTimeout(
                fetchLiveIndexQuote(symbol as LiveIndexSymbol, today),
                INJECT_BUDGET_MS,
                null,
              );
              if (iq && iq.close > 0) {
                todayQuote = { open: iq.open, high: iq.high, low: iq.low, close: iq.close, volume: iq.volume };
              }
            } else if (isTW) {
              // 台股個股由下方中央 L2 一次讀取；這裡不另打單股 MIS/Fugle。
            } else if (isCN && !isCnIndex && !cnLunchBreak) {
              // 指數不走 EastMoney 個股報價（會誤回平安銀行）→ 落到下方 L2 fallback 取指數即時值
              const cnSuffix = /\.SS$/i.test(symbol) ? 'SS' : /\.SZ$/i.test(symbol) ? 'SZ' : undefined;
              const q = await withTimeout(getEastMoneySingleQuote(pureCode, cnSuffix), INJECT_BUDGET_MS, null);
              if (q && q.close > 0 && q.date === today && isFreshProviderQuote('CN', q.date, q.updatedAt)) {
                todayQuote = q;
              } else if (q) {
                console.warn(`[stock] CN即時報價跳過 ${symbol}: close=${q.close}`);
              }
            }
          } catch (err) {
            console.warn(`[stock] 即時報價失敗 ${symbol}:`, err instanceof Error ? err.message : err);
          }

          // 從中央 L2 全市場快照中找該股報價
          if (!todayQuote && !isTwIndex && !isCnIndex && Date.now() < injectDeadline) {
            try {
              const snapshot = await withTimeout(readIntradaySnapshot(market as 'TW' | 'CN', today), Math.max(500, injectDeadline - Date.now()), null);
              if (snapshot && !assessIntradayFreshness(market as 'TW' | 'CN', snapshot).stale) {
                const sq = snapshot.quotes.find(q => q.symbol === l2LookupSymbol);
                if (sq && sq.close > 0) {
                  todayQuote = { open: sq.open, high: sq.high, low: sq.low, close: sq.close, volume: sq.volume };
                } else {
                  console.warn(`[stock] L2快照找不到 ${symbol} (pureCode=${pureCode}), 快照有${snapshot.quotes.length}檔, 取樣: ${snapshot.quotes.slice(0, 3).map(q => q.symbol).join(',')}`);
                }
              } else {
                console.warn(`[stock] L2快照不存在 market=${market} date=${today}`);
              }
            } catch (err) {
              console.warn(`[stock] L2 fallback 失敗 ${symbol}:`, err instanceof Error ? err.message : err);
            }
          }

          if (todayQuote) {
            // L3 報價健全檢查：防止千倍誤差等數據異常傳到前端
            const sanity = checkQuoteSanity(
              todayQuote.close,
              todayQuote.volume,
              lastCandle.close,
              lastCandle.volume,
              market,
            );
            if (sanity.level === 'critical') {
              console.error(
                `[stock] ★ ${symbol} 報價異常 (critical): ${sanity.message} ` +
                `即時=${todayQuote.close} vs L1=${lastCandle.close}`
              );
              // critical → 不使用此報價，用 L1 最後收盤價替代
              todayQuote = null;
            } else if (sanity.level === 'warning') {
              console.warn(
                `[stock] ${symbol} 報價偏差 (warning): ${sanity.message} ` +
                `即時=${todayQuote.close} vs L1=${lastCandle.close}`
              );
            }
          }

          if (todayQuote) {
            // OHLC 一致性修正：push2 API 有時回傳垃圾值（日期拼接、漲跌幅當價格）
            const { open, high, low, close } = todayQuote;
            const safeOpen  = (open > 0 && open > close * 0.5 && open < close * 1.5)  ? open  : close;
            const safeHigh  = (high > 0 && high >= close && high < close * 1.5)        ? high  : Math.max(safeOpen, close);
            const safeLow   = (low > 0  && low <= close && low > close * 0.5)          ? low   : Math.min(safeOpen, close);
            const todayBar = {
              date: today,
              open: safeOpen,
              high: safeHigh,
              low: safeLow,
              close: todayQuote.close,
              volume: todayQuote.volume,
            };
            if (lastIsToday) {
              result.candles[result.candles.length - 1] = todayBar;
            } else {
              result.candles.push(todayBar);
            }
          }
        }

        // ── 補注入 scanDate K 棒（掃描日期在 L1 缺失時從 L2 快照補入） ──
        // 常見情境：scanDate=04-14，但 L1 只到 04-13（下載未完成），
        // 今日 bar 已注入為 04-15，但圖表定位到 04-14 時找不到對應 K 棒 → 顯示 04-13
        if (scanDate && scanDate < today) {
          const hasScanDateBar = result.candles.some(c => c.date === scanDate);
          if (!hasScanDateBar) {
            try {
              const scanSnapshot = await readIntradaySnapshot(market as 'TW' | 'CN', scanDate);
              if (scanSnapshot) {
                const sq = scanSnapshot.quotes.find(q => q.symbol === l2LookupSymbol);
                if (sq && sq.close > 0 && (!isTW || sq.isActualTrade !== false)) {
                  // 插入 scanDate K 棒（按日期順序）
                  const scanCandle = {
                    date: scanDate,
                    open: sq.open || sq.close,
                    high: sq.high || sq.close,
                    low: sq.low || sq.close,
                    close: sq.close,
                    volume: sq.volume || 0,
                  };
                  // 找到插入位置（保持日期升序）
                  const insertIdx = result.candles.findIndex(c => c.date > scanDate);
                  if (insertIdx === -1) {
                    result.candles.push(scanCandle);
                  } else {
                    result.candles.splice(insertIdx, 0, scanCandle);
                  }
                  console.log(`[stock] 補注入 scanDate=${scanDate} K 棒 ${symbol}: close=${sq.close} from L2 snapshot`);
                }
              }
            } catch (err) {
              console.warn(`[stock] scanDate L2 補注入失敗 ${symbol} ${scanDate}:`, err instanceof Error ? err.message : err);
            }
          }
        }

        let withIndicators = computeIndicators(
          result.candles.map(c => ({ date: c.date, open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume }))
        );

        // 週K/月K：本地日K聚合（省去 API 請求）+ memory cache
        if (interval === '1wk' || interval === '1mo') {
          // cache key 包含 today close，價格變動時自動失效
          const todayClose = result.candles[result.candles.length - 1]?.close ?? 0;
          const cacheKey = `${symbol}:${interval}:${todayClose}`;
          const cached = aggregateCache.get(cacheKey);
          if (cached && cached.expires > Date.now()) {
            withIndicators = cached.data as typeof withIndicators;
          } else {
            const rawDaily = result.candles.map(c => ({ date: c.date, open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume }));
            const aggregated = aggregateCandles(rawDaily, interval);
            withIndicators = computeIndicators(aggregated);
            aggregateCache.set(cacheKey, { data: withIndicators, expires: Date.now() + AGGREGATE_CACHE_TTL });
          }
        }

        let name = candidates[0];
        const localName = await resolveChineseName({ isTW, isCN, pureCode, symbol });
        if (localName) name = localName;
        const indexName = INDEX_NAMES[candidates[0].toUpperCase()];
        if (indexName) name = indexName;
        return apiOk({
          ticker: loadedTicker,
          name,
          currency: '',
          interval,
          candles: withIndicators.map(c => ({ date: c.date, open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume })),
          totalBars: withIndicators.length,
          source: 'local',
          staleDays: result.staleDays,
        }, { headers: { 'Cache-Control': 'no-store, no-cache, must-revalidate' } });
      }
    } catch (localErr) {
      // 本地讀取失敗，fallthrough 到正常 API 路徑
      console.warn(`[stock] 本地資料載入失敗 (${symbol}):`, localErr instanceof Error ? localErr.message : localErr);
    }
  }

  try {
    let candles: { date: string; open: number; high: number; low: number; close: number; volume: number }[] = [];
    let ticker = candidates[0];

    // 台股分鐘 K 線：Fugle historical（多日歷史）+ intraday（今日盤中）合併
    // historical 提供 7+ 天 5m K，intraday 提供 30 秒延遲的今日最新 bar
    if (isTW && isMinuteInterval && isFugleAvailable()) {
      try {
        const [historicalRaw, intradayCandles] = await Promise.all([
          getFugleHistoricalMinuteCandles(pureCode, interval, period).catch(() => []),
          getFugleIntradayCandles(pureCode, interval).catch(() => []),
        ]);
        // historical 是新→舊（descending），reverse 成 ascending
        const historical = [...historicalRaw].reverse();
        // dedup by 時間戳（同一根以 intraday 為準，較新）＋ 排序 ascending。
        // 修：週末/盤後 Fugle intraday 會回「上一場 session」的整批 bar，舊寫法
        //（historical 過濾今日 + 直接 concat intraday）會讓同一天重複且時間倒退
        //（…07-09 13:30, 07-09 09:00, 09:30…），害均線/走圖畫成鋸齒扇形。
        const byTime = new Map<string, (typeof historical)[number]>();
        for (const c of historical) byTime.set(c.date, c);
        for (const c of intradayCandles) byTime.set(c.date, c);
        const merged = [...byTime.values()].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
        if (merged.length > 0) {
          ticker = candidates[0];
          candles = merged;
        }
      } catch {
        // Fugle 例外，繼續往下
      }
    }

    // MultiMarketProvider 多源備援（日K 主要路徑，或 CN/US 分鐘 K 的備援）
    if (candles.length === 0) {
      // 外部抓取設共用時間預算（C-2）：外部來源卡死時（如本機 DNS 把外網解到假 IP、Node fetch 直連卡死）
      // 不讓整條 request 卡 70s；逾時當作落空，往下走 L1 退路 / 404。
      const HIST_BUDGET_MS = Number(process.env.STOCK_HIST_BUDGET_MS) || 9000;
      const histDeadline = Date.now() + HIST_BUDGET_MS;
      for (const candidate of candidates) {
        try {
          const remaining = Math.max(500, histDeadline - Date.now());
          const result = await withTimeout(
            dataProvider.getHistoricalCandles(candidate, period, undefined, interval),
            remaining,
            [],
          );
          if (result.length > 0) {
            ticker = candidate;
            candles = result.map(c => ({
              date: c.date,
              open: c.open,
              high: c.high,
              low: c.low,
              close: c.close,
              volume: c.volume,
            }));
            break;
          }
        } catch {
          continue;
        }
      }
    }

    // C-2 退路：外部來源全逾時/落空時，TW/CN 日K 退回本地 L1 封存（至少有圖、不卡死也不 404）
    if (candles.length === 0 && !isMinuteInterval && (isTW || isCN)) {
      try {
        const market = isTW ? 'TW' as const : 'CN' as const;
        const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Taipei' }).format(new Date());
        for (const candidate of candidates) {
          const local = await loadLocalCandlesWithTolerance(candidate, market, today, 5);
          if (local && local.candles.length > 0) {
            ticker = candidate;
            candles = local.candles.map(c => ({
              date: c.date, open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume,
            }));
            break;
          }
        }
      } catch { /* 退路失敗就往下 404 */ }
    }

    if (candles.length === 0) {
      return apiError(
        `找不到股票代號 ${symbol}。台股格式：2330（上市）/8299（上櫃）、陸股：603986（上海）/000858（深圳）、美股：AAPL`,
        404,
      );
    }

    // ── 非宇宙 CN 日線：dataProvider 只到昨日封存 → 用即時報價補今日那根 ──
    // 創業板/科創不在 L1（走 dataProvider on-demand）也不在 L2 快照 → 上面 local 路徑的今日注入碰不到，
    // 主圖會停在昨日。三色 overlay 的 asOf 跟著主圖最後一根，主圖補了今日它才會跟著補 → 此處是源頭。
    // 與 cn-sanse/chart 用同一個 buildTodayBarFromQuote（騰訊報價 + 量單位對齊），確保兩邊今日那根一致。
    if (isCN && !isCnIndex && !isMinuteInterval) {
      try {
        const todayCN = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(new Date());
        const lastBar = candles[candles.length - 1];
        const { isTradingDay } = await import('@/lib/utils/tradingDay');
        if (lastBar && lastBar.date < todayCN && isTradingDay(todayCN, 'CN')) {
          const { fetchQuote, buildTodayBarFromQuote } = await import('@/lib/cn-sanse/cnQuote');
          const todayBar = buildTodayBarFromQuote(await fetchQuote(ticker), candles.slice(-20), todayCN);
          if (todayBar) {
            // 報價健全檢查（防千倍誤差），對齊 local 路徑；critical 才丟棄
            const sanity = checkQuoteSanity(todayBar.close, todayBar.volume, lastBar.close, lastBar.volume, 'CN');
            if (sanity.level !== 'critical') candles.push(todayBar);
          }
        }
      } catch { /* 注入失敗不致命，退回封存 */ }
    }

    // 中文名稱查詢 — 走共用 resolveChineseName（3s 預算、local/API 兩路徑同一份，防 drift）
    let name = ticker;
    const resolvedName = await resolveChineseName({ isTW, isCN, pureCode, symbol });
    if (resolvedName) name = resolvedName;
    const indexName = INDEX_NAMES[ticker.toUpperCase()];
    if (indexName) name = indexName;

    return apiOk(
      { ticker, name, currency: '', interval, candles, totalBars: candles.length },
      { headers: { 'Cache-Control': 'no-store, no-cache, must-revalidate' } },
    );
  } catch (err: unknown) {
    console.error('[stock] error:', err);
    const msg = err instanceof Error ? err.message : String(err);
    const isTimeout = msg.includes('timeout') || msg.includes('ETIMEDOUT') || msg.includes('abort');
    const isRateLimit = msg.includes('429') || msg.includes('rate') || msg.includes('limit');
    if (isTimeout) {
      return apiError(`${symbol} 資料請求逾時，請稍後重試`, 504);
    }
    if (isRateLimit) {
      return apiError(`${symbol} 資料來源限流中，請等待 1-2 分鐘後重試`, 429);
    }
    return apiError(`${symbol} 資料暫時無法取得：${msg.slice(0, 100)}`);
  }
}
