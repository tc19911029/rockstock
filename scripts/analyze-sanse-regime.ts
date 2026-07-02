// ============================================================
// 三色 — 逐 regime「對大盤 lift」細看（無搜尋；讀 optimize-result-*.json 的最佳化參數）
//
// 補 optimize 報告 §3 的缺口：原本只列池勝率、沒列「同 regime 的大盤基準」→ 無法判斷
// 「池在某盤勢有沒有真贏大盤」。這支對 OOS 逐 regime 算：大盤基準勝率 + 池/該買集的勝率與 lift。
//
// 用法：npx tsx scripts/analyze-sanse-regime.ts <TW|CN>
// ============================================================

import { promises as fs } from 'fs';
import path from 'path';
import { getLocalCandleDir } from '@/lib/datasource/LocalCandleStore';
import { computeSanSe } from '@/lib/cn-sanse/selectors';
import { computeDualB, computeXys } from '@/lib/cn-sanse/dualB';
import { PRODUCTION_PARAMS, type SanSeParams } from '@/lib/cn-sanse/params';
import type { Candle } from '@/types';

type Market = 'TW' | 'CN';
type Regime = 'bull' | 'chop' | 'bear';
const FWD_WINDOW = 32, WARMUP = 480, MIN_BARS = WARMUP + FWD_WINDOW + 8, LIMIT_GAP = 0.095;
const TRAIN_FRAC = 0.65, SEED = 20260603;
const SAMPLE: Record<Market, number> = { CN: 250, TW: 200 };
const CN_SH = '000001.SS', CN_SZ = '399001.SZ', TW_IDX = '^TWII';
const round2 = (x: number) => (Number.isFinite(x) ? Math.round(x * 100) / 100 : 0);

function mulberry32(a: number) { return () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
function sample<T>(arr: T[], k: number): T[] { if (arr.length <= k) return [...arr]; const r = mulberry32(SEED); const idx = arr.map((_, i) => i); for (let i = idx.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [idx[i], idx[j]] = [idx[j], idx[i]]; } return idx.slice(0, k).map((i) => arr[i]); }
async function readRaw(dir: string, sym: string): Promise<Candle[] | null> { try { const d = JSON.parse(await fs.readFile(path.join(dir, `${sym}.json`), 'utf8')); if (!Array.isArray(d?.candles)) return null; const cs = d.candles as Candle[]; for (const c of cs) if (typeof c.date === 'string' && c.date.endsWith('*')) c.date = c.date.slice(0, -1); return cs; } catch { return null; } }
const closeMap = (cs: Candle[] | null) => { const m = new Map<string, number>(); if (cs) for (const c of cs) m.set(c.date, c.close); return m; };
async function loadUniverse(market: Market, dir: string): Promise<string[]> {
  if (market === 'TW') return (await fs.readdir(dir)).filter((f) => /^(\d{4})\.(TW|TWO)\.json$/.test(f) && !f.startsWith('00')).map((f) => f.replace(/\.json$/, ''));
  const raw = JSON.parse(await fs.readFile(path.join(process.cwd(), 'data/cn_stocklist.json'), 'utf8'));
  const seen = new Set<string>(); const out: string[] = [];
  for (const s of (raw.stocks ?? []) as { symbol: string; name: string }[]) {
    const code = s.symbol.split('.')[0];
    if (!s.symbol || s.symbol === CN_SH || s.symbol === CN_SZ || /^(30|688|8|4)/.test(code) || s.name.includes('ST') || s.name.startsWith('*') || s.name.startsWith('S') || s.name.includes('退') || seen.has(s.symbol)) continue;
    seen.add(s.symbol); out.push(s.symbol);
  }
  return out;
}
function regimeMap(idx: Candle[]): Map<string, Regime> {
  const c = idx.map((x) => x.close); const ma = (n: number, i: number) => (i + 1 < n ? null : c.slice(i - n + 1, i + 1).reduce((a, b) => a + b, 0) / n);
  const m = new Map<string, Regime>();
  for (let i = 0; i < idx.length; i++) { const m20 = ma(20, i), m60 = ma(60, i); let r: Regime = 'chop'; if (m20 != null && m60 != null) { if (c[i] > m20 && c[i] > m60) r = 'bull'; else if (c[i] < m20 && c[i] < m60) r = 'bear'; } m.set(idx[i].date, r); }
  return m;
}
interface Fwd { tradable: boolean; d5: number | null }
function forwardAt(O: number[], H: number[], L: number[], C: number[], n: number, i: number): Fwd | null {
  if (i + 1 >= n) return null; const base = O[i + 1]; if (!(base > 0)) return null;
  const locked = L[i + 1] > 0 && O[i + 1] === H[i + 1] && (H[i + 1] - L[i + 1]) / L[i + 1] < 0.005;
  const tradable = !(locked || (O[i + 1] - C[i]) / C[i] >= LIMIT_GAP);
  const d5 = i + 5 < n ? +(((C[i + 5] - base) / base) * 100).toFixed(3) : null;
  return { tradable, d5 };
}
/** bar i 在參數 p 下：是否在池(mainforce)、grade 是否 top/prime（buy 集）。 */
function classify(s: ReturnType<typeof computeSanSe>, db: ReturnType<typeof computeDualB>, xys: ReturnType<typeof computeXys>, i: number): { pool: boolean; buy: boolean } {
  const pool = s.strict[i] || s.medium[i] || s.loose[i];
  const bBuy = !!(db.goldCross[i] || db.breakUp[i]); const cBuy = !!xys.goldCross[i];
  const gbc = (pool ? 1 : 0) + (bBuy ? 1 : 0) + (cBuy ? 1 : 0);
  if (gbc < 1) return { pool: false, buy: false };
  const redOn = round2(s.midStrength[i]) > 0; const trigger = bBuy || cBuy;
  const top = gbc === 3; const prime = !top && redOn && trigger;
  return { pool, buy: top || prime };
}
const stat = (a: number[]) => ({ n: a.length, win: a.length ? Math.round(a.filter((x) => x > 0).length / a.length * 100) : null, avg: a.length ? +(a.reduce((x, y) => x + y, 0) / a.length).toFixed(2) : null });
const liftStr = (w: number | null, b: number | null) => (w == null || b == null ? '—' : `${w - b > 0 ? '+' : ''}${w - b}pp`);

async function main() {
  const market = (process.argv[2] ?? '').toUpperCase() as Market;
  if (market !== 'TW' && market !== 'CN') throw new Error('用法：analyze-sanse-regime.ts <TW|CN>');
  const dir = getLocalCandleDir(market);
  const outDir = path.join(process.cwd(), 'data', market === 'TW' ? 'tw-sanse' : 'cn-sanse');
  const opt = JSON.parse(await fs.readFile(path.join(outDir, `optimize-result-${market}.json`), 'utf8')).params as SanSeParams;

  const idxSH = await readRaw(dir, market === 'TW' ? TW_IDX : CN_SH);
  if (!idxSH?.length) throw new Error('找不到指數');
  const mapSH = closeMap(idxSH); const mapSZ = market === 'CN' ? closeMap(await readRaw(dir, CN_SZ)) : mapSH; const mapSZeff = mapSZ.size ? mapSZ : mapSH;
  const reg = regimeMap(idxSH); const dates = idxSH.map((c) => c.date);
  const cutHigh = dates[Math.min(dates.length - 1, Math.floor(dates.length * TRAIN_FRAC) + FWD_WINDOW)];

  const universe = sample(await loadUniverse(market, dir), SAMPLE[market]);
  // 累計器：[regime] → 各集 d5 陣列
  const mk = () => ({ base: [] as number[], poolP: [] as number[], poolO: [] as number[], buyP: [] as number[], buyO: [] as number[] });
  const acc: Record<Regime, ReturnType<typeof mk>> = { bull: mk(), chop: mk(), bear: mk() };
  let used = 0;
  const BATCH = 80;
  for (let b = 0; b < universe.length; b += BATCH) {
    const loaded = await Promise.all(universe.slice(b, b + BATCH).map((s) => readRaw(dir, s)));
    universe.slice(b, b + BATCH).forEach((symbol, k) => {
      const candles = loaded[k]; if (!candles || candles.length < MIN_BARS) return;
      const O = candles.map((c) => c.open), H = candles.map((c) => c.high), L = candles.map((c) => c.low), C = candles.map((c) => c.close), n = candles.length;
      const home = market === 'CN' && symbol.endsWith('.SZ') ? mapSZeff : mapSH; let last = NaN;
      const idxClose = candles.map((c) => { const v = home.get(c.date); if (v != null) last = v; return last; });
      const sP = computeSanSe(candles, idxClose, NaN, PRODUCTION_PARAMS), dbP = computeDualB(candles, PRODUCTION_PARAMS), xP = computeXys(candles, PRODUCTION_PARAMS);
      const sO = computeSanSe(candles, idxClose, NaN, opt), dbO = computeDualB(candles, opt), xO = computeXys(candles, opt);
      used++;
      for (let i = WARMUP; i <= n - 1 - FWD_WINDOW; i++) {
        const date = candles[i].date; if (date < cutHigh) continue;             // 只看 OOS
        const f = forwardAt(O, H, L, C, n, i); if (!f || !f.tradable || f.d5 == null) continue;
        const r = reg.get(date) ?? 'chop'; const a = acc[r];
        a.base.push(f.d5);
        const cP = classify(sP, dbP, xP, i); if (cP.pool) a.poolP.push(f.d5); if (cP.buy) a.buyP.push(f.d5);
        const cO = classify(sO, dbO, xO, i); if (cO.pool) a.poolO.push(f.d5); if (cO.buy) a.buyO.push(f.d5);
      }
    });
  }

  const L: string[] = [];
  L.push(`# 三色 逐 regime 對大盤 lift 細看 — ${market === 'TW' ? '台股' : '陸股'}（OOS ≥ ${cutHigh}，抽樣 ${used} 檔）`);
  L.push('');
  L.push('lift = 該集 d5 勝率 − **同 regime 大盤基準**勝率（正＝在該盤勢真的贏大盤）。');
  L.push('');
  L.push('| regime | 大盤基準(n/勝率) | 池·prod(勝率/lift) | 池·opt(勝率/lift) | 該買·prod(勝率/lift) | 該買·opt(勝率/lift) |');
  L.push('|---|---|---|---|---|---|');
  for (const r of ['bull', 'chop', 'bear'] as Regime[]) {
    const a = acc[r]; const sb = stat(a.base), pP = stat(a.poolP), pO = stat(a.poolO), bP = stat(a.buyP), bO = stat(a.buyO);
    L.push(`| ${r} | ${sb.n} / ${sb.win}% | ${pP.win ?? '—'}% / ${liftStr(pP.win, sb.win)} (n${pP.n}) | ${pO.win ?? '—'}% / ${liftStr(pO.win, sb.win)} (n${pO.n}) | ${bP.win ?? '—'}% / ${liftStr(bP.win, sb.win)} (n${bP.n}) | ${bO.win ?? '—'}% / ${liftStr(bO.win, sb.win)} (n${bO.n}) |`);
  }
  L.push('');
  L.push('> 「該買」= combo grade top/prime（紅在場＋觸發）。lift>0 且樣本夠＝該盤勢有 alpha。');
  const md = L.join('\n');
  await fs.writeFile(path.join(outDir, `regime-detail-${market}.md`), md, 'utf8');
  console.log('\n' + md);
}
main().catch((e) => { console.error(e); process.exit(1); });
