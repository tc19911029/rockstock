/**
 * CH5 新型態誠實 edge 回測 — 底部③（反彈站月線橫盤突破）+ 強勢飆股第二波
 *
 * 這兩個 detector（lib/rules/ch5SelectionRules.ts）目前是「顯示層觸發規則」，
 * 走圖上標示、不進選股 gate。本腳本量它們在「隔日開盤進場」後的前瞻報酬 /
 * 扣成本淨超額 / train-test 一致性，判斷有沒有真 edge、能否升級成 gate/排序。
 * （CLAUDE.md 誠實 edge 紀律：正 alpha 且 train/test 一致才進主視圖。）
 *
 * **完全不動生產**：直接 import 現有 production detector 逐檔逐日呼叫。
 *
 * 口徑（對齊 backtest-bottom-formation-c16.ts）：
 *   - 進場 = 觸發日「次一交易日開盤」
 *   - 前瞻報酬 = (dN close − entry open) / entry open
 *   - 淨超額 = 策略報酬 − 同窗 ^TWII 買入持有 − 來回成本（raw 含大盤 beta，不可當 alpha）
 *   - train/test：依觸發日中位數切兩段
 *
 * Usage:
 *   NODE_OPTIONS="--max-old-space-size=8192" npx tsx scripts/backtest-ch5-new-patterns.ts [START] [END] [MAX_FILES]
 */

import fs from 'fs';
import path from 'path';
import { computeIndicators } from '@/lib/indicators';
import { reboundHoldMA20Breakout, strongSurgeSecondWave } from '@/lib/rules/ch5SelectionRules';
import { FEE_RATES } from '@/lib/portfolio/fees';
import type { CandleWithIndicators } from '@/types';

const START = process.argv[2] ?? '2023-06-01';
const END = process.argv[3] ?? '2026-05-20';
const MAX_FILES = process.argv[4] ? parseInt(process.argv[4], 10) : Infinity;
const HORIZONS = [1, 5, 10, 20] as const;
const ROUND_TRIP_PCT = (FEE_RATES.TW.buy + FEE_RATES.TW.sell) * 100;

const ROOT = path.join(process.cwd(), 'data');
const TW_DIR = path.join(ROOT, 'candles', 'TW');

interface Bar { date: string; open: number; high: number; low: number; close: number; volume: number }

function loadBars(file: string): Bar[] {
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf-8'));
    const arr = Array.isArray(raw) ? raw : raw.candles ?? [];
    return arr
      .map((c: Record<string, unknown>) => ({
        date: String(c.date ?? '').slice(0, 10),
        open: Number(c.open) || 0, high: Number(c.high) || 0,
        low: Number(c.low) || 0, close: Number(c.close) || 0,
        volume: Number(c.volume) || 0,
      }))
      .filter((c: Bar) => c.date && c.close > 0)
      .sort((a: Bar, b: Bar) => a.date.localeCompare(b.date));
  } catch { return []; }
}

const idxBars = loadBars(path.join(TW_DIR, '^TWII.json'));
const idxDates = idxBars.map(b => b.date);
function idxCloseOnOrAfter(date: string): { date: string; close: number } | null {
  let lo = 0, hi = idxDates.length - 1, ans = -1;
  while (lo <= hi) { const m = (lo + hi) >> 1; if (idxDates[m] >= date) { ans = m; hi = m - 1; } else lo = m + 1; }
  if (ans < 0) return null;
  return { date: idxDates[ans], close: idxBars[ans].close };
}
function idxHoldReturn(entryDate: string, holdBars: number): number | null {
  const e = idxCloseOnOrAfter(entryDate);
  if (!e) return null;
  const ei = idxDates.indexOf(e.date);
  if (ei < 0 || ei + holdBars >= idxBars.length) return null;
  const exit = idxBars[ei + holdBars].close;
  if (!(e.close > 0)) return null;
  return (exit - e.close) / e.close * 100;
}

const mean = (a: number[]) => a.length ? a.reduce((s, x) => s + x, 0) / a.length : NaN;
const winRate = (a: number[]) => a.length ? a.filter(x => x > 0).length / a.length * 100 : NaN;
type Sample = { date: string; ret: Record<number, number>; excess: Record<number, number> };

function summarize(rows: Sample[], h: number) {
  const rets = rows.map(r => r.ret[h]).filter(x => x != null && !isNaN(x));
  const exc = rows.map(r => r.excess[h]).filter(x => x != null && !isNaN(x));
  const avgRet = mean(rets);
  const avgExc = mean(exc);
  const netExc = avgExc - ROUND_TRIP_PCT;
  return { n: rets.length, avgRet: +avgRet.toFixed(2), win: +winRate(rets).toFixed(1), avgExc: +avgExc.toFixed(2), netExc: +netExc.toFixed(2) };
}
function splitTrainTest(rows: Sample[]): { train: Sample[]; test: Sample[]; cut: string } {
  const sorted = [...rows].sort((a, b) => a.date.localeCompare(b.date));
  const cut = sorted.length ? sorted[Math.floor(sorted.length / 2)].date : '';
  return { train: sorted.filter(r => r.date < cut), test: sorted.filter(r => r.date >= cut), cut };
}

function measure(ci: CandleWithIndicators[], idx: number): Sample | null {
  const d = ci[idx].date;
  if (!d || d < START || d > END) return null;
  const entry = ci[idx + 1];
  if (!entry || !(entry.open > 0)) return null;
  if (Math.abs(entry.open - ci[idx].close) / ci[idx].close > 0.25) return null;
  const ret: Record<number, number> = {};
  const excess: Record<number, number> = {};
  let ok = false;
  for (const h of HORIZONS) {
    const exitBar = ci[idx + h];
    if (!exitBar || !(exitBar.close > 0)) continue;
    const stratRet = (exitBar.close - entry.open) / entry.open * 100;
    const idxRet = idxHoldReturn(entry.date, h);
    ret[h] = stratRet;
    if (idxRet != null) excess[h] = stratRet - idxRet;
    ok = true;
  }
  return ok ? { date: d, ret, excess } : null;
}

interface Variant { id: string; label: string; hit: (ci: CandleWithIndicators[], index: number) => boolean }
const VARIANTS: Variant[] = [
  { id: '底部③', label: '反彈站月線橫盤突破', hit: (ci, i) => reboundHoldMA20Breakout.evaluate(ci, i) != null },
  { id: '飆股第二波', label: '凌厲第一波後回檔不破月線再起', hit: (ci, i) => strongSurgeSecondWave.evaluate(ci, i) != null },
];

const samples: Record<string, Sample[]> = {};
for (const v of VARIANTS) samples[v.id] = [];

let files = fs.readdirSync(TW_DIR).filter(f => /^\d{4}\.TW\.json$/.test(f));
if (MAX_FILES !== Infinity) files = files.slice(0, MAX_FILES);
let scanned = 0;
const t0 = Date.now();

for (const f of files) {
  const bars = loadBars(path.join(TW_DIR, f));
  if (bars.length < 80) continue;
  const ci: CandleWithIndicators[] = computeIndicators(bars as CandleWithIndicators[]);
  scanned++;
  for (let idx = 65; idx < ci.length - 1; idx++) {
    const d = ci[idx].date;
    if (!d || d < START || d > END) continue;
    for (const v of VARIANTS) {
      if (v.hit(ci, idx)) {
        const s = measure(ci, idx);
        if (s) samples[v.id].push(s);
      }
    }
  }
}

const elapsed = ((Date.now() - t0) / 1000).toFixed(0);
console.log(`\n=== CH5 新型態誠實 edge 回測（${START} ~ ${END}）===`);
console.log(`掃描 ${scanned} 檔 / 來回成本 ${ROUND_TRIP_PCT.toFixed(3)}% / 耗時 ${elapsed}s`);
console.log(`基準：現有 TW 前 20 策略 d5 raw cohort 報酬門檻 ≈ +0.65%（strategy-leaderboard.json）\n`);

for (const v of VARIANTS) {
  const rows = samples[v.id];
  console.log(`【${v.id} ${v.label}】候選 ${rows.length} 筆`);
  if (rows.length === 0) { console.log('  （無命中）\n'); continue; }
  console.log('  期別          H    n     平均報酬%  勝率%   平均超額%  淨超額%');
  const { train, test, cut } = splitTrainTest(rows);
  const segs: Array<[string, Sample[]]> = [['全部', rows], [`train<${cut}`, train], [`test≥${cut}`, test]];
  for (const [name, seg] of segs) {
    for (const h of HORIZONS) {
      const s = summarize(seg, h);
      console.log(`  ${name.padEnd(14)} d${String(h).padEnd(2)} ${String(s.n).padStart(5)}  ${String(s.avgRet).padStart(8)}  ${String(s.win).padStart(6)}  ${String(s.avgExc).padStart(8)}  ${String(s.netExc).padStart(7)}`);
    }
  }
  console.log('');
}

console.log('=== 總表（d5 / d20；判準：raw報酬 vs 前20門檻0.65% + 淨超額 + train/test 同號）===');
console.log('  變體                       H   n全   raw報酬%  淨超額%  train淨超%  test淨超%  一致?');
for (const v of VARIANTS) {
  const rows = samples[v.id];
  if (rows.length === 0) continue;
  const { train, test } = splitTrainTest(rows);
  for (const h of [5, 20] as const) {
    const all = summarize(rows, h);
    const tr = summarize(train, h);
    const te = summarize(test, h);
    const consistent = (tr.netExc > 0 && te.netExc > 0) ? '✓正' : (tr.netExc < 0 && te.netExc < 0) ? '✓負' : '✗分歧';
    const tag = `${v.id} ${v.label}`.slice(0, 24);
    console.log(`  ${tag.padEnd(26)} d${String(h).padEnd(2)} ${String(all.n).padStart(4)}  ${String(all.avgRet).padStart(7)}  ${String(all.netExc).padStart(6)}  ${String(tr.netExc).padStart(9)}  ${String(te.netExc).padStart(8)}   ${consistent}`);
  }
}
console.log('');
