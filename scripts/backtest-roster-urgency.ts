/**
 * 獵兔看板排序驗證 — classifyHuntCategory 的 urgency「即將發動」排序準不準？
 *
 * 問題：看板把「三角收斂尾端/回檔止跌」等高 urgency 標成「明天最可能發動」排最前。
 *   這個排序到底有沒有預測力？高 urgency 之後報酬真的比較好嗎？還是只是排版好看？
 *
 * 做法：對 TW 全市場逐檔逐日跑現有 production `classifyHuntCategory`（純函式），
 *   命中就記 urgency + 分類，隔日開盤進場，量 d1/5/10/20 前瞻報酬 / 對 ^TWII 淨超額 / train-test。
 *   再按 urgency 分桶（≥85 即將發動 / 65-84 準備中 / <65 等待中）與 8 分類各自匯總。
 *   （不動生產、只讀 production 函式。判準同 CLAUDE.md 誠實 edge。）
 *
 * Usage:
 *   NODE_OPTIONS="--max-old-space-size=8192" npx tsx scripts/backtest-roster-urgency.ts [START] [END] [MAX_FILES]
 */

import fs from 'fs';
import path from 'path';
import { computeIndicators } from '@/lib/indicators';
import { classifyHuntCategory, HUNT_LABELS, type HuntCategory } from '@/lib/scanner/lockRoster';
import { FEE_RATES } from '@/lib/portfolio/fees';
import type { CandleWithIndicators } from '@/types';

const START = process.argv[2] ?? '2023-06-01';
const END = process.argv[3] ?? '2026-05-20';
const MAX_FILES = process.argv[4] ? parseInt(process.argv[4], 10) : Infinity;
const HORIZONS = [1, 5, 10, 20] as const;
const ROUND_TRIP_PCT = (FEE_RATES.TW.buy + FEE_RATES.TW.sell) * 100;
const TW_DIR = path.join(process.cwd(), 'data', 'candles', 'TW');

interface Bar { date: string; open: number; high: number; low: number; close: number; volume: number }
function loadBars(file: string): Bar[] {
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf-8'));
    const arr = Array.isArray(raw) ? raw : raw.candles ?? [];
    return arr.map((c: Record<string, unknown>) => ({
      date: String(c.date ?? '').slice(0, 10),
      open: Number(c.open) || 0, high: Number(c.high) || 0, low: Number(c.low) || 0,
      close: Number(c.close) || 0, volume: Number(c.volume) || 0,
    })).filter((c: Bar) => c.date && c.close > 0).sort((a: Bar, b: Bar) => a.date.localeCompare(b.date));
  } catch { return []; }
}

const idxBars = loadBars(path.join(TW_DIR, '^TWII.json'));
const idxDates = idxBars.map(b => b.date);
function idxHoldReturn(entryDate: string, holdBars: number): number | null {
  let lo = 0, hi = idxDates.length - 1, ans = -1;
  while (lo <= hi) { const m = (lo + hi) >> 1; if (idxDates[m] >= entryDate) { ans = m; hi = m - 1; } else lo = m + 1; }
  if (ans < 0 || ans + holdBars >= idxBars.length) return null;
  const e = idxBars[ans].close, exit = idxBars[ans + holdBars].close;
  return e > 0 ? (exit - e) / e * 100 : null;
}

const mean = (a: number[]) => a.length ? a.reduce((s, x) => s + x, 0) / a.length : NaN;
const winRate = (a: number[]) => a.length ? a.filter(x => x > 0).length / a.length * 100 : NaN;
type Sample = { date: string; ret: Record<number, number>; excess: Record<number, number> };

function summarize(rows: Sample[], h: number) {
  const rets = rows.map(r => r.ret[h]).filter(x => x != null && !isNaN(x));
  const exc = rows.map(r => r.excess[h]).filter(x => x != null && !isNaN(x));
  return { n: rets.length, avgRet: +mean(rets).toFixed(2), win: +winRate(rets).toFixed(1), netExc: +(mean(exc) - ROUND_TRIP_PCT).toFixed(2) };
}
function splitTrainTest(rows: Sample[]) {
  const s = [...rows].sort((a, b) => a.date.localeCompare(b.date));
  const cut = s.length ? s[Math.floor(s.length / 2)].date : '';
  return { train: s.filter(r => r.date < cut), test: s.filter(r => r.date >= cut) };
}
function measure(ci: CandleWithIndicators[], idx: number): Sample | null {
  const d = ci[idx].date;
  if (!d || d < START || d > END) return null;
  const entry = ci[idx + 1];
  if (!entry || !(entry.open > 0)) return null;
  if (Math.abs(entry.open - ci[idx].close) / ci[idx].close > 0.25) return null;
  const ret: Record<number, number> = {}, excess: Record<number, number> = {};
  let ok = false;
  for (const h of HORIZONS) {
    const ex = ci[idx + h];
    if (!ex || !(ex.close > 0)) continue;
    const sr = (ex.close - entry.open) / entry.open * 100;
    const ir = idxHoldReturn(entry.date, h);
    ret[h] = sr; if (ir != null) excess[h] = sr - ir; ok = true;
  }
  return ok ? { date: d, ret, excess } : null;
}

const urgencyBuckets: Record<string, Sample[]> = { '即將發動(≥85)': [], '準備中(65-84)': [], '等待中(<65)': [] };
const catBuckets: Record<number, Sample[]> = {};
for (let k = 1 as HuntCategory; k <= 8; k++) catBuckets[k] = [];

let files = fs.readdirSync(TW_DIR).filter(f => /^\d{4}\.TW\.json$/.test(f));
if (MAX_FILES !== Infinity) files = files.slice(0, MAX_FILES);
let scanned = 0; const t0 = Date.now();

for (const f of files) {
  const bars = loadBars(path.join(TW_DIR, f));
  if (bars.length < 80) continue;
  const ci = computeIndicators(bars as CandleWithIndicators[]);
  scanned++;
  for (let idx = 65; idx < ci.length - 1; idx++) {
    const d = ci[idx].date;
    if (!d || d < START || d > END) continue;
    const cls = classifyHuntCategory(ci, idx);
    if (!cls) continue;
    const s = measure(ci, idx);
    if (!s) continue;
    const bk = cls.urgency >= 85 ? '即將發動(≥85)' : cls.urgency >= 65 ? '準備中(65-84)' : '等待中(<65)';
    urgencyBuckets[bk].push(s);
    catBuckets[cls.category].push(s);
  }
}

const elapsed = ((Date.now() - t0) / 1000).toFixed(0);
console.log(`\n=== 獵兔看板 urgency 排序驗證（${START} ~ ${END}）===`);
console.log(`掃描 ${scanned} 檔 / 來回成本 ${ROUND_TRIP_PCT.toFixed(3)}% / 耗時 ${elapsed}s\n`);

console.log('── 依 urgency 分桶（看板「明天最可能發動」= 高 urgency）──');
console.log('  桶                H    n     平均報酬%  勝率%   淨超額%   train淨超  test淨超  一致?');
for (const bk of ['即將發動(≥85)', '準備中(65-84)', '等待中(<65)']) {
  const rows = urgencyBuckets[bk];
  const { train, test } = splitTrainTest(rows);
  for (const h of [5, 20] as const) {
    const a = summarize(rows, h), tr = summarize(train, h), te = summarize(test, h);
    const con = (tr.netExc > 0 && te.netExc > 0) ? '✓正' : (tr.netExc < 0 && te.netExc < 0) ? '✓負' : '✗分歧';
    console.log(`  ${bk.padEnd(16)} d${String(h).padEnd(2)} ${String(a.n).padStart(5)}  ${String(a.avgRet).padStart(8)}  ${String(a.win).padStart(6)}  ${String(a.netExc).padStart(7)}  ${String(tr.netExc).padStart(8)}  ${String(te.netExc).padStart(7)}   ${con}`);
  }
}

console.log('\n── 依 8 分類（在等什麼）──');
console.log('  分類                H    n     平均報酬%  勝率%   淨超額%   train淨超  test淨超  一致?');
for (let k = 1; k <= 8; k++) {
  const rows = catBuckets[k];
  if (rows.length < 30) { console.log(`  ${HUNT_LABELS[k as HuntCategory].padEnd(16)} — n=${rows.length}（樣本不足）`); continue; }
  const { train, test } = splitTrainTest(rows);
  for (const h of [5, 20] as const) {
    const a = summarize(rows, h), tr = summarize(train, h), te = summarize(test, h);
    const con = (tr.netExc > 0 && te.netExc > 0) ? '✓正' : (tr.netExc < 0 && te.netExc < 0) ? '✓負' : '✗分歧';
    console.log(`  ${HUNT_LABELS[k as HuntCategory].padEnd(16)} d${String(h).padEnd(2)} ${String(a.n).padStart(5)}  ${String(a.avgRet).padStart(8)}  ${String(a.win).padStart(6)}  ${String(a.netExc).padStart(7)}  ${String(tr.netExc).padStart(8)}  ${String(te.netExc).padStart(7)}   ${con}`);
  }
}
console.log('');
