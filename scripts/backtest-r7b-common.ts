/**
 * R7b 批次回測共用底座（一次性驗證腳本，不進生產）
 *
 * 誠實 edge 紀律：
 *  - 報酬一律去大盤 beta：excess = 個股 fwd − ^TWII 同期 fwd
 *  - train/test 對半切（依日期），兩段方向一致才算過關
 *  - 樣本 <100 標「樣本不足」
 */
import fs from 'fs';
import path from 'path';
import { computeIndicators } from '@/lib/indicators';
import type { CandleWithIndicators } from '@/types';

export const TW_DIR = path.join(process.cwd(), 'data/candles/TW');
export const MIN_TURNOVER = 50_000_000; // 5000 萬（TW volume 單位=張）
export const HORIZONS = [5, 20] as const;

export interface Stock {
  symbol: string;
  candles: CandleWithIndicators[];
}

/** ^TWII 日期 → index，用來算同期大盤報酬 */
export interface Bench {
  closeByDate: Map<string, number>;
  dates: string[];
  idxByDate: Map<string, number>;
}

export function loadBench(): Bench {
  const raw = JSON.parse(fs.readFileSync(path.join(TW_DIR, '^TWII.json'), 'utf-8'));
  const cs = (raw.candles ?? []).filter((c: { close: number }) => c.close > 0);
  const closeByDate = new Map<string, number>();
  const idxByDate = new Map<string, number>();
  const dates: string[] = [];
  cs.forEach((c: { date: string; close: number }, i: number) => {
    const d = c.date.slice(0, 10);
    closeByDate.set(d, c.close);
    idxByDate.set(d, i);
    dates.push(d);
  });
  return { closeByDate, dates, idxByDate };
}

/** 大盤同期報酬 %（以交易日對齊；不足則 null） */
export function benchFwd(b: Bench, date: string, h: number): number | null {
  const i = b.idxByDate.get(date);
  if (i == null || i + h >= b.dates.length) return null;
  const p0 = b.closeByDate.get(b.dates[i])!;
  const p1 = b.closeByDate.get(b.dates[i + h])!;
  if (!(p0 > 0)) return null;
  return (p1 / p0 - 1) * 100;
}

export function loadStocks(minLen = 300): Stock[] {
  const files = fs.readdirSync(TW_DIR).filter(f => f.endsWith('.json') && !f.startsWith('^') && !f.startsWith('_'));
  const out: Stock[] = [];
  let n = 0;
  process.stdout.write('  讀取 TW L1');
  for (const f of files) {
    const symbol = f.replace('.json', '');
    try {
      const raw = JSON.parse(fs.readFileSync(path.join(TW_DIR, f), 'utf-8'));
      const rawCandles = Array.isArray(raw) ? raw : raw.candles ?? [];
      const candles = rawCandles
        .map((c: Record<string, unknown>) => ({
          date: String(c.date ?? '').slice(0, 10),
          open: Number(c.open) || 0,
          high: Number(c.high) || 0,
          low: Number(c.low) || 0,
          close: Number(c.close) || 0,
          volume: Number(c.volume) || 0,
        }))
        .filter((c: { close: number; high: number; low: number }) => c.close > 0 && c.high > 0 && c.low > 0);
      if (candles.length < minLen) continue;
      out.push({ symbol, candles: computeIndicators(candles) });
      if (++n % 300 === 0) process.stdout.write('.');
    } catch { /* skip */ }
  }
  console.log(` → ${out.length} 支`);
  return out;
}

export function liquid(c: CandleWithIndicators): boolean {
  return c.close * (c.volume || 0) * 1000 >= MIN_TURNOVER;
}

// ── 統計工具 ────────────────────────────────────────────────────────────────

export interface Obs {
  date: string;
  symbol: string;
  /** horizon → 相對 ^TWII 超額 % */
  ex: Record<number, number>;
  /** horizon → 相對「同日宇宙平均」超額 %（消掉等權 vs 市值權的規模偏差） */
  exu?: Record<number, number>;
  [k: string]: unknown;
}

/**
 * 用「同日宇宙平均」當第二層基準填 exu。
 * ^TWII 是市值加權，等權宇宙長期系統性落後它（本專案實測 D20 −1.04%），
 * 只看 ^TWII 超額會讓所有子集看起來都是負的 → 必須再對同日宇宙去一次 beta。
 */
export function attachUniverseExcess(universe: Obs[], subsets: Obs[][]): void {
  const acc = new Map<string, Record<number, { s: number; n: number }>>();
  for (const o of universe) {
    let m = acc.get(o.date);
    if (!m) { m = Object.fromEntries(HORIZONS.map(h => [h, { s: 0, n: 0 }])); acc.set(o.date, m); }
    for (const h of HORIZONS) { if (Number.isFinite(o.ex[h])) { m[h].s += o.ex[h]; m[h].n++; } }
  }
  for (const arr of subsets) {
    for (const o of arr) {
      const m = acc.get(o.date);
      if (!m) continue;
      o.exu = Object.fromEntries(HORIZONS.map(h => [h, m[h].n ? o.ex[h] - m[h].s / m[h].n : NaN]));
    }
  }
}

export function mean(xs: number[]): number {
  return xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : NaN;
}

export function median(xs: number[]): number {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** t 統計量（單樣本 vs 0） */
export function tStat(xs: number[]): number {
  if (xs.length < 2) return NaN;
  const m = mean(xs);
  const v = xs.reduce((s, x) => s + (x - m) ** 2, 0) / (xs.length - 1);
  return m / Math.sqrt(v / xs.length);
}

export function splitDate(obs: { date: string }[]): string {
  const ds = obs.map(o => o.date).sort();
  return ds[Math.floor(ds.length / 2)] ?? '';
}

/**
 * 印一組 obs 的 train/test 表。
 * base='twii' 用 ^TWII 超額；base='univ' 用同日宇宙平均超額（需先跑 attachUniverseExcess）。
 */
export function reportGroup(label: string, obs: Obs[], mid: string, base: 'twii' | 'univ' = 'univ'): void {
  const pick = (o: Obs, h: number) => (base === 'univ' ? o.exu?.[h] ?? NaN : o.ex[h]);
  const segs: [string, Obs[]][] = [
    ['train', obs.filter(o => o.date < mid)],
    ['test ', obs.filter(o => o.date >= mid)],
    ['全期 ', obs],
  ];
  console.log(`\n── ${label}  [基準=${base === 'univ' ? '同日宇宙平均' : '^TWII'}] ──`);
  console.log('  段別    n       D5超額    D5 t    D20超額   D20 t   D20勝率');
  for (const [name, rows] of segs) {
    if (!rows.length) { console.log(`  ${name}  ${String(rows.length).padStart(6)}  (無樣本)`); continue; }
    const d5 = rows.map(o => pick(o, 5)).filter(Number.isFinite);
    const d20 = rows.map(o => pick(o, 20)).filter(Number.isFinite);
    const wr = d20.length ? d20.filter(x => x > 0).length / d20.length * 100 : NaN;
    console.log(
      `  ${name}  ${String(rows.length).padStart(6)}  ` +
      `${fmt(mean(d5))}  ${tStat(d5).toFixed(2).padStart(6)}  ` +
      `${fmt(mean(d20))}  ${tStat(d20).toFixed(2).padStart(6)}  ` +
      `${Number.isFinite(wr) ? wr.toFixed(0) + '%' : '—'}`,
    );
  }
  if (obs.length < 100) console.log('  ⚠ 樣本不足（<100）');
}

export function fmt(x: number): string {
  if (!Number.isFinite(x)) return '     —  ';
  return `${x >= 0 ? '+' : ''}${x.toFixed(2)}%`.padStart(8);
}
