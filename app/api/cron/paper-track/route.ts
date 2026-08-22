import { NextRequest } from 'next/server';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import path from 'path';
import { apiOk, apiError } from '@/lib/api/response';
import { checkCronAuth } from '@/lib/api/cronAuth';
import { buyScore } from '@/lib/cn-sanse/buyScore';
import { matchedStrategies } from '@/lib/cn-sanse/namedStrategies';
import { computeShadowLedger } from '@/lib/portfolio/shadowLedger';
import type { ConditionReport } from '@/lib/cn-sanse/conditions';
import type { Candle } from '@/types';
import { stockDisplayName } from '@/lib/stocks/stockIdentity';

export const runtime = 'nodejs';
export const maxDuration = 300;

/**
 * Paper-trade 自動追蹤（2026-06-12，B2 — 訊號→實單漏斗量測）。
 *
 * 每晚把「⭐全共振」全命中 + 「應買排序 top3」自動開 paper 單：
 *   - 進場 = 掃描日的『隔日收盤』（≈朱書 13:25 市價單；與 B1 回測變體同基準）
 *   - 出場 = 書本規則（與紀律影子帳本同一套 computeShadowLedger）
 *   - 漲停鎖死買不到 → unfillable（誠實記錄，不偷算）
 * 不碰真持倉、不下單 — 產生「若照系統做」的 live walk-forward 證據，
 * 一個月後回答：該信多少、下多重。
 *
 * 用法：cron GET ?run=1（auth）每日 19:05；GET 無參數 = 公開唯讀 summary（給 UI）。
 */

const FILE = path.join(process.cwd(), 'data', 'paper-trades.json');

interface PaperTrade {
  id: string;
  market: 'TW' | 'CN';
  symbol: string;
  name: string;
  strategy: 'resonance' | 'buytop';
  scanDate: string;
  status: 'pending_entry' | 'open' | 'closed' | 'unfillable';
  entryDate?: string;
  entryPrice?: number;
  lastClose?: number;
  lastDate?: string;
  pnlPct?: number;
  exitDate?: string;
  exitPrice?: number;
  exitReason?: string;
}

interface PaperDoc { schemaVersion: 1; updatedAt: string; trades: PaperTrade[] }

function loadDoc(): PaperDoc {
  try { return JSON.parse(readFileSync(FILE, 'utf8')) as PaperDoc; }
  catch { return { schemaVersion: 1, updatedAt: '', trades: [] }; }
}
function saveDoc(d: PaperDoc) {
  d.updatedAt = new Date().toISOString();
  mkdirSync(path.dirname(FILE), { recursive: true });
  writeFileSync(FILE, JSON.stringify(d, null, 2));
}

function loadCandles(symbol: string, market: 'TW' | 'CN'): Candle[] | null {
  for (const cand of market === 'TW' ? [symbol, symbol.replace(/\.TW$/, '.TWO')] : [symbol]) {
    const f = path.join(process.cwd(), 'data', 'candles', market, `${cand}.json`);
    if (existsSync(f)) {
      try {
        const j = JSON.parse(readFileSync(f, 'utf8'));
        return (Array.isArray(j) ? j : j.candles) as Candle[];
      } catch { /* 壞檔跳過 */ }
    }
  }
  return null;
}

interface SanseResp {
  ok: boolean; lastDate?: string;
  records?: Array<{ symbol: string; name?: string; price?: number; report: ConditionReport }>;
}

async function collectPicks(base: string, market: 'TW' | 'CN'): Promise<Array<{ symbol: string; name: string; strategy: 'resonance' | 'buytop'; scanDate: string }>> {
  const r = await fetch(`${base}/api/${market === 'TW' ? 'tw-sanse' : 'cn-sanse'}/scan`, { signal: AbortSignal.timeout(30_000) });
  const j = (await r.json()) as SanseResp;
  if (!j.ok || !j.lastDate || !j.records) return [];
  const out: Array<{ symbol: string; name: string; strategy: 'resonance' | 'buytop'; scanDate: string }> = [];
  // ⭐ 全共振（具名策略 'resonance'）全部
  for (const rec of j.records) {
    try {
      if (matchedStrategies(rec.report).some(s => s.id === 'resonance')) {
        out.push({ symbol: rec.symbol, name: stockDisplayName(rec.name, rec.symbol), strategy: 'resonance', scanDate: j.lastDate });
      }
    } catch { /* report 異形跳過 */ }
  }
  // 應買 top3
  const top = [...j.records]
    .sort((a, b) => buyScore(b.report) - buyScore(a.report))
    .slice(0, 3);
  for (const rec of top) {
    if (buyScore(rec.report) < 0) continue;
    out.push({ symbol: rec.symbol, name: stockDisplayName(rec.name, rec.symbol), strategy: 'buytop', scanDate: j.lastDate });
  }
  return out;
}

function summarize(doc: PaperDoc) {
  const closed = doc.trades.filter(t => t.status === 'closed');
  const open = doc.trades.filter(t => t.status === 'open');
  const byStrategy: Record<string, { n: number; openN: number; avgPnlPct: number | null; winRatePct: number | null }> = {};
  for (const strat of ['resonance', 'buytop'] as const) {
    const c = closed.filter(t => t.strategy === strat);
    const pnls = c.map(t => t.pnlPct).filter((x): x is number => x != null);
    byStrategy[strat] = {
      n: c.length,
      openN: open.filter(t => t.strategy === strat).length,
      avgPnlPct: pnls.length ? +(pnls.reduce((a, b) => a + b, 0) / pnls.length).toFixed(2) : null,
      winRatePct: pnls.length ? +(pnls.filter(x => x > 0).length / pnls.length * 100).toFixed(1) : null,
    };
  }
  const openPnls = open.map(t => t.pnlPct).filter((x): x is number => x != null);
  return {
    updatedAt: doc.updatedAt,
    total: doc.trades.length,
    open: open.length,
    closed: closed.length,
    unfillable: doc.trades.filter(t => t.status === 'unfillable').length,
    openAvgPnlPct: openPnls.length ? +(openPnls.reduce((a, b) => a + b, 0) / openPnls.length).toFixed(2) : null,
    byStrategy,
    trades: doc.trades.slice(-50).reverse(),
  };
}

export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  if (url.searchParams.get('run') !== '1') {
    // 公開唯讀 summary（UI 用）
    return apiOk(summarize(loadDoc()));
  }
  const denied = checkCronAuth(req);
  if (denied) return denied;

  const proto = req.headers.get('x-forwarded-proto') ?? 'http';
  const host = req.headers.get('host') ?? 'localhost:3000';
  const base = `${proto}://${host}`;
  const doc = loadDoc();
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Taipei' }).format(new Date());
  let added = 0, filled = 0, closedN = 0, marked = 0;

  // 1) 收新 picks（同 symbol+strategy 有未平倉單就不重開）
  for (const market of ['TW', 'CN'] as const) {
    try {
      const picks = await collectPicks(base, market);
      for (const p of picks) {
        const dup = doc.trades.some(t =>
          t.symbol === p.symbol && t.strategy === p.strategy &&
          (t.status === 'pending_entry' || t.status === 'open' || t.scanDate === p.scanDate));
        if (dup) continue;
        doc.trades.push({
          id: `${market}-${p.symbol}-${p.strategy}-${p.scanDate}`,
          market, symbol: p.symbol, name: p.name, strategy: p.strategy,
          scanDate: p.scanDate, status: 'pending_entry',
        });
        added++;
      }
    } catch { /* 單市場失敗不擋另一市場 */ }
  }

  // 2) pending_entry 補進場（掃描日後第一根的收盤；漲停鎖死 → unfillable）
  for (const t of doc.trades) {
    if (t.status !== 'pending_entry') continue;
    const candles = loadCandles(t.symbol, t.market);
    if (!candles) continue;
    const i = candles.findIndex(c => c.date === t.scanDate);
    if (i < 0 || i + 1 >= candles.length) continue; // 隔日 K 還沒出來
    const e = candles[i + 1];
    if (e.close === e.high && e.low > 0 && (e.high - e.low) / e.low < 0.005) {
      t.status = 'unfillable';
      t.exitReason = '漲停鎖死買不到';
      continue;
    }
    if (e.volume === 0 && e.open === e.close && e.high === e.low) continue; // 停牌等明天
    t.status = 'open';
    t.entryDate = e.date;
    t.entryPrice = e.close;
    filled++;
  }

  // 3) open 單：書本規則出場（與影子帳本同一套）+ mark-to-market
  for (const t of doc.trades) {
    if (t.status !== 'open' || !t.entryDate || !t.entryPrice) continue;
    const candles = loadCandles(t.symbol, t.market);
    if (!candles) continue;
    const r = computeShadowLedger({
      symbol: t.symbol,
      entryDate: t.entryDate,
      entryPrice: t.entryPrice,
      shares: 1000,
      stopLoss: t.entryPrice * 0.93,
      candles,
    });
    if (!r) continue;
    t.lastClose = r.lastClose;
    t.lastDate = r.lastDate;
    const fullExit = r.events.find(ev => ev.action !== 'reduce_half_ma5');
    if (fullExit) {
      t.status = 'closed';
      t.exitDate = fullExit.date;
      t.exitPrice = fullExit.price;
      t.exitReason = fullExit.label;
      t.pnlPct = +(((fullExit.price - t.entryPrice) / t.entryPrice) * 100).toFixed(2);
      closedN++;
    } else {
      t.pnlPct = +(((r.lastClose - t.entryPrice) / t.entryPrice) * 100).toFixed(2);
      marked++;
    }
  }

  saveDoc(doc);
  if (added + filled + closedN + marked === 0 && doc.trades.length === 0) {
    return apiError('no picks and empty ledger', 500);
  }
  return apiOk({ date: today, added, filled, closed: closedN, marked, total: doc.trades.length });
}
