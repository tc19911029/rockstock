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

export const runtime = 'nodejs';
export const maxDuration = 120;

type Quote = { open: number; high: number; low: number; close: number; volume: number };

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
    if (ageMs > 20 * 60_000) {
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

async function fetchTWQuotes(date: string): Promise<Map<string, Quote>> {
  const snap = await readSnapshotQuotes('TW', date);
  if (snap.size > 500) {
    console.log(`[append-from-snapshot] TW 用本地 L2 snapshot (${snap.size} 筆)`);
    return snap;
  }
  console.log(`[append-from-snapshot] TW 本地 snapshot 不足 (${snap.size})，fallback 打 TWSE realtime`);
  const { getTWSERealtimeIntraday } = await import('@/lib/datasource/TWSERealtime');
  const raw = await getTWSERealtimeIntraday();
  const out = new Map<string, Quote>();
  for (const [code, q] of raw) {
    if (q.close > 0) out.set(code, { open: q.open, high: q.high, low: q.low, close: q.close, volume: q.volume });
  }
  return out;
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
  const quotes = market === 'TW'
    ? await fetchTWQuotes(date)
    : await fetchCNQuotes(date, stocks.map((s) => s.symbol));
  if (quotes.size === 0) return apiOk({ skipped: true, reason: '0 筆報價' });

  let appended = 0;
  let already = 0;
  let skippedLimitUp = 0;
  const limitUpSkipped: string[] = [];

  await Promise.allSettled(stocks.map(async ({ symbol }) => {
    const code = symbol.replace(/\.(TW|TWO|SS|SZ)$/i, '');
    const existing = await readCandleFile(symbol, market);
    if (!existing) return;
    // DF3 修正：>= 確保 L1 已封今日 bar 時不被 L2 snapshot 蓋（個股 already 邏輯；
    // same-day 覆寫只允許指數，見下方指數分支）。原 `> date` 只擋未來日、形同沒擋。
    if (existing.lastDate >= date) { already++; return; }
    const q = quotes.get(code);
    if (!q) return;

    // Limit-up close-overwrite guard（lib/datasource/limitMoveGuard.ts）：
    // 漲跌停股 close 在收盤集合競價，盤中 snapshot tick 可能不是真正收盤。
    const prev = existing.candles[existing.candles.length - 1];
    if (suspectsLimitOverwrite(prev?.close, q, market, code) || suspectsGrossJump(prev?.close, q)) {
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
    ]);
    appended++;
  }));

  // 大盤指數（^TWII / 000001.SS）— scanner.getStockList 不含指數，必須另外處理。
  // L2 snapshot 內 symbol 已帶 suffix（避 CN 個股 000001 撞 key），這裡直接 quotes.get(suffix 版)。
  // 0518 修：之前指數靠 Vercel cron download-candles-batch?batch=1 走 Yahoo 抓（vol 常 0），
  // 改成由 IntradayCache 從 mis.twse/Tencent 抓，append-from-snapshot 一併寫 L1，本地 cron 也涵蓋。
  let indexAppended = false;
  const indexSymbol = market === 'TW' ? '^TWII' : '000001.SS';
  const indexQuote = quotes.get(indexSymbol);
  if (indexQuote) {
    const existing = await readCandleFile(indexSymbol, market);
    // 指數允許 same-day 覆寫（個股的 already 邏輯不適用）：
    // 多輪 refresh 後一次比前一次更接近收盤；下游 CandleStorageAdapter merge
    // 對指數有 isIndex+V=0 防呆（incoming vol=0 但 existing vol>0 → 保留 existing），
    // 所以「真實 vol>0 蓋過 vol=0」「同日重複寫不會把已有好值蓋成 0」雙向都安全。
    if (existing && existing.lastDate <= date) {
      const merged = existing.candles.filter(c => c.date !== date);
      merged.push({ date, open: indexQuote.open, high: indexQuote.high, low: indexQuote.low, close: indexQuote.close, volume: indexQuote.volume });
      await saveLocalCandles(indexSymbol, market, merged);
      indexAppended = true;
    }
  }

  return apiOk({ market, date, appended, already, skippedLimitUp, limitUpSkipped, total: stocks.length, indexAppended });
}
