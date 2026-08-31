// GET /api/cron/append-from-snapshot — 收盤後用全市場即時報價補 L1 K 棒
//
// 比 download-candles 快（5 秒完成全市場），用 TWSE/EastMoney 單一 API 一次拿所有收盤價
// instrumentation.ts 在 isPostCloseWindow 後 30 分鐘觸發

import { NextRequest } from 'next/server';
import { apiOk } from '@/lib/api/response';
import { isPostCloseWindow, isMarketOpen, getLastTradingDay } from '@/lib/datasource/marketHours';
import { isTradingDay } from '@/lib/utils/tradingDay';
import { readCandleFile } from '@/lib/datasource/CandleStorageAdapter';
import { saveLocalCandles } from '@/lib/datasource/LocalCandleStore';
import { suspectsLimitOverwrite, suspectsGrossJump } from '@/lib/datasource/limitMoveGuard';
import { checkCronAuth } from '@/lib/api/cronAuth';
import { verifyDownload } from '@/lib/datasource/DownloadVerifier';
import { isSnapshotTooOldForSeal } from '@/lib/datasource/snapshotFreshness';

export const runtime = 'nodejs';
export const maxDuration = 120;

type Quote = { open: number; high: number; low: number; close: number; volume: number };

async function confirmCNSuspiciousCloses(
  date: string,
  stocks: Array<{ symbol: string }>,
  quotes: Map<string, Quote>,
): Promise<Set<string>> {
  const { independentlyConfirmsCnClose } = await import('@/lib/datasource/limitMoveGuard');
  const suspects: string[] = [];
  const CONCURRENCY = 50;

  for (let index = 0; index < stocks.length; index += CONCURRENCY) {
    const batch = stocks.slice(index, index + CONCURRENCY);
    const rows = await Promise.all(batch.map(async stock => ({
      symbol: stock.symbol,
      existing: await readCandleFile(stock.symbol, 'CN').catch(() => null),
    })));
    for (const { symbol, existing } of rows) {
      const code = symbol.replace(/\.(SS|SZ)$/i, '');
      const quote = quotes.get(code);
      const previous = existing?.candles.at(-1);
      if (
        quote
        && quote.volume > 0
        && existing
        && previous
        && existing.lastDate < date
        && suspectsLimitOverwrite(previous.close, quote, 'CN', code)
      ) {
        suspects.push(symbol);
      }
    }
  }

  if (suspects.length === 0) return new Set();
  const { getSinaRealtime } = await import('@/lib/datasource/SinaRealtime');
  const secondary = await getSinaRealtime(suspects);
  const confirmed = new Set<string>();
  for (const symbol of suspects) {
    const code = symbol.replace(/\.(SS|SZ)$/i, '');
    if (independentlyConfirmsCnClose(quotes.get(code)!, secondary.get(code), date)) {
      confirmed.add(code);
    }
  }
  console.log(
    `[append-from-snapshot] CN 漲跌停打開候選 ${suspects.length} 檔，`
    + `Sina 同日 OHLC 獨立確認 ${confirmed.size} 檔`,
  );
  return confirmed;
}

// 優先從本地 L2 snapshot 讀（dev server 盤中已累積完整 OHLC，比重打 API 可靠）。
// L2 檔由 update-intraday cron 定期刷新到 data/intraday-{market}-{date}.json，
// 結構：{ quotes: [{symbol (bare), open, high, low, close, volume, ... }] }
async function readSnapshotQuotes(market: 'TW' | 'CN', date: string): Promise<Map<string, Quote>> {
  const out = new Map<string, Quote>();
  try {
    const fs = await import('node:fs/promises');
    const path = await import('node:path');
    const file = path.join(process.cwd(), 'data', `intraday-${market}-${date}.json`);
    const raw = await fs.readFile(file, 'utf-8');
    const json = JSON.parse(raw) as { updatedAt?: string; quotes?: Array<{ symbol: string; open: number; high: number; low: number; close: number; volume: number }> };
    const quotes = json.quotes ?? [];

    // ── stale/盤前快照守衛（2026-06-08 事故根因）─────────────────────────────────
    // 事故：盤中 L2 刷新壞掉、快照凍在 09:27 盤前集合競價（每檔只有單一價 → O=H=L=C 平棒）。
    // 盤後 append-from-snapshot 照樣讀它、把平棒當收盤封進 L1，污染全市場 ~2292 檔（雙B 誤判跌破等）。
    // 封 L1 是不可逆的歷史寫入（鐵則 #1），故這裡兩道守衛，命中就回空 Map → 呼叫端 fallback 即時 API：
    //   (1) updatedAt 太舊：盤後封存必須讀「剛刷新」的快照；> 20 分鐘視為沒刷新成功。
    //   (2) 全市場「單點平棒」(O=H=L=C) 佔比 > 50%：盤前集合競價的指紋，絕非真實收盤分布。
    const ageMs = json.updatedAt ? Date.now() - new Date(json.updatedAt).getTime() : Infinity;
    if (isSnapshotTooOldForSeal(market, date, json.updatedAt)) {
      console.warn(`[append-from-snapshot] ${market} L2 快照過舊 (age ${Math.round(ageMs / 60000)}min)，拒用避免封 stale → fallback 即時 API`);
      return out;
    }
    let flat = 0, valid = 0;
    for (const q of quotes) {
      if (q.close > 0) { valid++; if (q.open === q.high && q.high === q.low && q.low === q.close) flat++; }
    }
    if (valid > 0 && flat / valid > 0.5) {
      console.warn(`[append-from-snapshot] ${market} L2 快照 ${flat}/${valid} 是單點平棒(疑盤前集合競價/未刷新)，拒用避免封 stale → fallback 即時 API`);
      return out;
    }

    for (const q of quotes) {
      if (q.close > 0 && q.open > 0) {
        out.set(q.symbol, { open: q.open, high: q.high, low: q.low, close: q.close, volume: q.volume });
      }
    }
  } catch { /* 檔案不存在或解析失敗 → 回空 Map，由呼叫端 fallback */ }
  return out;
}

async function fetchTWQuotes(date: string): Promise<{
  quotes: Map<string, Quote>;
  ready: boolean;
  reason?: string;
  twseRows: number;
  tpexRows: number;
}> {
  // 封存只讀交易所盤後日線。L2 與 mis.twse 在 z='-' 時可能只有買賣中價，
  // 即使 OHLC 自洽也不是成交價，不能進 sealed L1。
  const { prefetchVendorBatch } = await import('@/lib/datasource/eodSettleBatch');
  const cache = await prefetchVendorBatch('TW', date);
  const { assessTwOfficialReadiness } = await import('@/lib/datasource/eodSettlePolicy');
  const readiness = assessTwOfficialReadiness({
    market: 'TW',
    targetDate: date,
    twseRows: cache.twseBulk.size,
    tpexRows: cache.tpexBulk.size,
  });
  const out = new Map<string, Quote>();
  for (const [code, q] of cache.twseBulk) out.set(code, q);
  for (const [code, q] of cache.tpexBulk) out.set(code, q);
  if (readiness.ready) {
    const [{ fetchTwseIndexCandles }, { fetchTpexIndexCandles }] = await Promise.all([
      import('@/lib/datasource/TwseIndexProvider'),
      import('@/lib/datasource/TpexIndexProvider'),
    ]);
    const [twseIndex, tpexIndex] = await Promise.all([
      fetchTwseIndexCandles(date, date).then(rows => rows.find(row => row.date === date) ?? null),
      fetchTpexIndexCandles(date, date).then(rows => rows.find(row => row.date === date) ?? null),
    ]);
    if (twseIndex) out.set('^TWII', twseIndex);
    if (tpexIndex) out.set('^TWOII', tpexIndex);
  }
  console.log(`[append-from-snapshot] TW 用官方盤後日線（TWSE ${cache.twseBulk.size} / TPEx ${cache.tpexBulk.size}）`);
  return {
    quotes: out,
    ready: readiness.ready,
    reason: readiness.reason,
    twseRows: cache.twseBulk.size,
    tpexRows: cache.tpexBulk.size,
  };
}

const bareCode = (symbol: string) => symbol.replace(/\.(SS|SZ)$/i, '');

async function fetchCNQuotes(date: string, symbols: string[]): Promise<Map<string, Quote>> {
  const out = new Map<string, Quote>();
  const snap = await readSnapshotQuotes('CN', date);
  if (snap.size > 500) {
    console.log(`[append-from-snapshot] CN 用本地 L2 snapshot (${snap.size} 筆)`);
    for (const [code, q] of snap) out.set(code, q);
  } else {
    console.log(`[append-from-snapshot] CN 本地 snapshot 不足 (${snap.size})，打 EastMoney realtime`);
    try {
      const { getEastMoneyRealtime } = await import('@/lib/datasource/EastMoneyRealtime');
      const raw = await getEastMoneyRealtime();
      for (const [code, q] of raw) {
        if (q.close > 0) out.set(code, { open: q.open, high: q.high, low: q.low, close: q.close, volume: q.volume });
      }
    } catch { /* fallthrough */ }
  }

  // 用清單比對缺漏 → 騰訊補缺。涵蓋兩種情況：(1) 東財 push2 整個掛（本機常 TLS reset/502）；
  // (2) 本地快照或 push2 只回主板、缺科創/創業（snapshot writer 沒涵蓋新板）。
  // 騰訊 qt.gtimg.cn 直連可達、量單位板塊敏感已對齊。見記憶 cn_gem_star_added_to_scan。
  const missing = symbols.filter((s) => !out.has(bareCode(s)));
  if (missing.length > 200) {
    console.warn(`[append-from-snapshot] CN 清單缺 ${missing.length} 檔報價 → 騰訊補缺`);
    try {
      const { getTencentRealtime } = await import('@/lib/datasource/TencentRealtime');
      const ten = await getTencentRealtime(missing);
      let added = 0;
      for (const [code, q] of ten) {
        if (q.close > 0 && !out.has(code)) {
          out.set(code, { open: q.open, high: q.high, low: q.low, close: q.close, volume: q.volume });
          added++;
        }
      }
      console.log(`[append-from-snapshot] CN 騰訊補 ${added} 檔，共 ${out.size} 筆`);
    } catch (e) { console.warn('[append-from-snapshot] CN 騰訊補缺失敗', e); }
  }
  return out;
}

export async function GET(req: NextRequest) {
  const authDenied = checkCronAuth(req);
  if (authDenied) return authDenied;

  const market = (req.nextUrl.searchParams.get('market') ?? 'TW') as 'TW' | 'CN';
  const force = req.nextUrl.searchParams.get('force') === '1';
  const date = getLastTradingDay(market);

  if (!isTradingDay(date, market)) {
    return apiOk({ skipped: true, reason: '非交易日' });
  }
  // 盤中絕對不能寫 L1（盤中價當收盤會污染）— force 也擋
  if (isMarketOpen(market)) {
    return apiOk({ skipped: true, reason: '盤中，等收盤' });
  }
  // ?force=1 只跳過 isPostCloseWindow gate（窗口外手動補修用），不跳 isMarketOpen
  if (!force && !isPostCloseWindow(market)) {
    return apiOk({ skipped: true, reason: '非盤後窗口' });
  }

  const scanner = market === 'TW'
    ? new (await import('@/lib/scanner/TaiwanScanner')).TaiwanScanner()
    : new (await import('@/lib/scanner/ChinaScanner')).ChinaScanner();
  const stocks = await scanner.getStockList();

  // CN 走「本地快照 → 東財即時 → 騰訊即時」三層 fallback（東財 push2 常掛時靠騰訊補當日 bar）。
  let quotes: Map<string, Quote>;
  let twOfficialRows: { twseRows: number; tpexRows: number } | null = null;
  if (market === 'TW') {
    const official = await fetchTWQuotes(date);
    if (!official.ready) {
      return apiOk({
        skipped: true,
        reason: `${official.reason ?? '官方盤後日線未到齊'}；不封存，下一輪重試`,
        market,
        date,
      });
    }
    quotes = official.quotes;
    twOfficialRows = { twseRows: official.twseRows, tpexRows: official.tpexRows };
  } else {
    quotes = await fetchCNQuotes(date, stocks.map((s) => s.symbol));
  }
  if (quotes.size === 0) return apiOk({ skipped: true, reason: '0 筆報價' });
  const cnLimitConfirmations = market === 'CN'
    ? await confirmCNSuspiciousCloses(date, stocks, quotes)
    : new Set<string>();

  let appended = 0;
  let corrected = 0;
  let already = 0;
  let skippedLimitUp = 0;
  const limitUpSkipped: string[] = [];

  await Promise.allSettled(stocks.map(async ({ symbol }) => {
    const code = symbol.replace(/\.(TW|TWO|SS|SZ)$/i, '');
    const existing = await readCandleFile(symbol, market);
    if (!existing) return;
    const q = quotes.get(code);
    if (existing.lastDate > date) { already++; return; }
    if (existing.lastDate === date) {
      // TW 的當日 bar 可能是舊流程留下的 MIS/L2 暫時價；只要官方值不同就必須覆寫。
      // 沒有官方 row 時不把它算成 already，留給正式 settlement 判斷停牌或繼續補抓。
      if (market !== 'TW') { already++; return; }
      if (!q) return;
      const current = existing.candles.at(-1)!;
      const officialSame = current.open === q.open
        && current.high === q.high
        && current.low === q.low
        && current.close === q.close
        && current.volume === q.volume;
      if (officialSame) { already++; return; }
      await saveLocalCandles(symbol, market, [
        ...existing.candles.filter(candle => candle.date !== date),
        { date, open: q.open, high: q.high, low: q.low, close: q.close, volume: q.volume },
      ], { trustedOfficial: true });
      appended++;
      corrected++;
      return;
    }
    if (!q) return;
    // 當日零成交沒有真實 K 棒：保留上一筆 L1，交給 verifier 標 no_trade。
    if (market === 'CN' && q.volume <= 0) return;

    // TW 來源是交易所官方盤後日線，漲跌停本來就是合法收盤，不可再套用只適合
    // 盤中 snapshot tick 的 limit-overwrite heuristic。CN 仍走 snapshot/provider chain，保留守門。
    const prev = existing.candles[existing.candles.length - 1];
    const suspectedLimitOverwrite = market === 'CN'
      && suspectsLimitOverwrite(prev?.close, q, market, code);
    if (
      (suspectedLimitOverwrite && !cnLimitConfirmations.has(code))
      || suspectsGrossJump(prev?.close, q)
    ) {
      console.warn(
        `[append-from-snapshot] ${symbol} ${date} close 異常(漲跌停/單日>50%偏離=疑撞庫壞抓) ` +
        `(prev=${prev.close} h=${q.high} l=${q.low} c=${q.close})，skip 寫入避免 L1 污染`
      );
      skippedLimitUp++;
      if (limitUpSkipped.length < 20) limitUpSkipped.push(symbol);
      return;
    }

    await saveLocalCandles(symbol, market, [
      ...existing.candles,
      { date, open: q.open, high: q.high, low: q.low, close: q.close, volume: q.volume },
    ], market === 'TW'
      ? { trustedOfficial: true }
      : cnLimitConfirmations.has(code)
        ? { limitOverwriteConfirmed: true }
        : undefined);
    appended++;
  }));

  // 大盤指數（^TWII / ^TWOII / 000001.SS）— scanner.getStockList 不含指數，必須另外處理。
  // L2 snapshot 內 symbol 已帶 suffix（避 CN 個股 000001 撞 key），這裡直接 quotes.get(suffix 版)。
  // 0518 修：之前指數靠 Vercel cron download-candles-batch?batch=1 走 Yahoo 抓（vol 常 0），
  // TW 改用交易所官方指數日線；CN 才沿用收盤快照。
  const indexSymbols = market === 'TW' ? ['^TWII', '^TWOII'] : ['000001.SS'];
  const indexAppended: string[] = [];
  for (const indexSymbol of indexSymbols) {
    const indexQuote = quotes.get(indexSymbol);
    if (!indexQuote) continue;
    let existing = await readCandleFile(indexSymbol, market);
    // ^TWOII 第一次啟用時沒有 L1：先用官方 TPEx 歷史資料建檔，再追加當日即時值。
    if (!existing && indexSymbol === '^TWOII') {
      const idxCandles = await scanner.fetchCandles(indexSymbol);
      if (idxCandles.length > 0) {
        await saveLocalCandles(indexSymbol, market, idxCandles);
        existing = await readCandleFile(indexSymbol, market);
      }
    }
    // 指數允許 same-day 覆寫（個股的 already 邏輯不適用）：
    // 多輪 refresh 後一次比前一次更接近收盤；下游 CandleStorageAdapter merge
    // 對指數有 isIndex+V=0 防呆（incoming vol=0 但 existing vol>0 → 保留 existing），
    // 所以「真實 vol>0 蓋過 vol=0」「同日重複寫不會把已有好值蓋成 0」雙向都安全。
    if (existing && existing.lastDate <= date) {
      const merged = existing.candles.filter(c => c.date !== date);
      merged.push({ date, open: indexQuote.open, high: indexQuote.high, low: indexQuote.low, close: indexQuote.close, volume: indexQuote.volume });
      await saveLocalCandles(indexSymbol, market, merged);
      indexAppended.push(indexSymbol);
    }
  }

  // 這是策略掃描前最後一次補寫；必須重建 coverage report。
  // 否則 scan 讀到的是早一輪 download-batch 的舊報告，可能放行殘缺資料或誤擋已補齊資料。
  const verification = await verifyDownload(
    market,
    date,
    stocks.map((stock) => stock.symbol),
    {
      succeeded: appended,
      skipped: already,
      failed: Math.max(0, stocks.length - appended - already),
    },
  );

  if (market === 'TW' && twOfficialRows) {
    const noTradeSymbols = stocks
      .map(stock => stock.symbol.replace(/\.(TW|TWO)$/i, ''))
      .filter(code => !quotes.has(code));
    const { saveTWOfficialCloseState } = await import('@/lib/datasource/twOfficialCloseState');
    await saveTWOfficialCloseState({
      market: 'TW',
      date,
      settledAt: new Date().toISOString(),
      ...twOfficialRows,
      noTradeSymbols,
    });
  }

  return apiOk({
    market,
    date,
    appended,
    corrected,
    already,
    skippedLimitUp,
    limitUpSkipped,
    total: stocks.length,
    indexAppended,
    ...(twOfficialRows ? { officialRows: twOfficialRows } : {}),
    verify: {
      health: verification.health,
      coverageRate: verification.summary.coverageRate,
      stocksCurrent: verification.summary.stocksCurrent,
      stocksMissingTargetDate: verification.summary.stocksMissingTargetDate,
    },
  });
}
