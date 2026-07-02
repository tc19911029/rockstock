/**
 * 進場-14 研究專用回測：一字底（D 軌）窄幅門檻 15%（生產）vs 10%（書本 ≤10%）對照
 *
 * 背景：detectStrategyE（D 軌一字底）盤整窄幅上限現用 CONSOL_MAX_TIGHTNESS=0.15。
 *   筆記註解寫 8%、書本《抓住飆股》一字底是 ≤10%。本腳本用 detectStrategyE 的
 *   研究專用 opts.maxTightness 旗標（預設 0.15、生產位元不變），把窄幅收緊到 0.10
 *   做對照組，看 D 軌前瞻報酬 / 淨超額 / train/test 是否更好。
 *
 * **不動生產**：只在本腳本傳 opts，生產 scanner 永遠走 undefined → 0.15。
 *
 * 北極星口徑：
 *   - 進場 = 觸發日「次一交易日開盤」（對齊實單，不用收盤）
 *   - 前瞻報酬 = (dN close - entry open) / entry open
 *   - 淨超額 = 策略報酬 − 同窗 ^TWII 買入持有報酬 − 來回成本
 *   - train/test：依觸發日中位數切兩段，兩段同口徑各算一次
 *
 * Usage:
 *   NODE_OPTIONS="--max-old-space-size=8192" npx tsx scripts/backtest-flatbottom-tightness.ts [START] [END]
 *   預設 START=2023-06-01 END=2026-05-31（留 20 日結算尾巴）
 */

import fs from 'fs';
import path from 'path';
import { computeIndicators } from '@/lib/indicators';
import { detectStrategyE } from '@/lib/analysis/highWinRateEntry';
import { FEE_RATES } from '@/lib/portfolio/fees';
import type { CandleWithIndicators } from '@/types';

const START = process.argv[2] ?? '2023-06-01';
const END   = process.argv[3] ?? '2026-05-31';
const HORIZONS = [1, 5, 10, 20] as const;
const ROUND_TRIP_PCT = (FEE_RATES.TW.buy + FEE_RATES.TW.sell) * 100; // 來回成本 %
const VARIANTS = [
  { label: '生產 15%', maxTightness: 0.15 },
  { label: '書本 10%', maxTightness: 0.10 },
] as const;

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

// ── 指數：日期 → 收盤，用來算 buy&hold 超額 ─────────────────────────────────
const idxBars = loadBars(path.join(TW_DIR, '^TWII.json'));
const idxByDate = new Map<string, number>();
idxBars.forEach(b => idxByDate.set(b.date, b.close));
const idxDates = idxBars.map(b => b.date);
function idxCloseOnOrAfter(date: string): { date: string; close: number } | null {
  // 二分找第一個 >= date
  let lo = 0, hi = idxDates.length - 1, ans = -1;
  while (lo <= hi) { const m = (lo + hi) >> 1; if (idxDates[m] >= date) { ans = m; hi = m - 1; } else lo = m + 1; }
  if (ans < 0) return null;
  return { date: idxDates[ans], close: idxBars[ans].close };
}
/** 指數同窗 buy&hold 報酬 %：entryDate 開盤近似用當日收盤、出場用 entry + N 交易日 close */
function idxHoldReturn(entryDate: string, holdBars: number): number | null {
  const e = idxCloseOnOrAfter(entryDate);
  if (!e) return null;
  const ei = idxDates.indexOf(e.date);
  if (ei < 0 || ei + holdBars >= idxBars.length) return null;
  const exit = idxBars[ei + holdBars].close;
  if (!(e.close > 0)) return null;
  return (exit - e.close) / e.close * 100;
}

// ── 主迴圈：掃每檔每天，分別用兩個 tightness 觸發 D ────────────────────────
type Sample = { date: string; ret: Record<number, number>; excess: Record<number, number> };
const samples: Record<string, Sample[]> = { '生產 15%': [], '書本 10%': [] };

const files = fs.readdirSync(TW_DIR).filter(f => /^\d{4}\.TW\.json$/.test(f));
let scanned = 0;
const t0 = Date.now();

for (const f of files) {
  const bars = loadBars(path.join(TW_DIR, f));
  if (bars.length < 80) continue;
  const ci: CandleWithIndicators[] = computeIndicators(bars as CandleWithIndicators[]);
  scanned++;

  for (let idx = 60; idx < ci.length; idx++) {
    const d = ci[idx].date;
    if (!d || d < START || d > END) continue;
    // 進場 = 次一交易日開盤
    const entry = ci[idx + 1];
    if (!entry || !(entry.open > 0)) continue;

    for (const v of VARIANTS) {
      const r = detectStrategyE(ci, idx, { maxTightness: v.maxTightness });
      if (!r?.isFlatBottom) continue;

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
      if (ok) samples[v.label].push({ date: d, ret, excess });
    }
  }
}

// ── 統計工具 ────────────────────────────────────────────────────────────────
const mean = (a: number[]) => a.length ? a.reduce((s, x) => s + x, 0) / a.length : NaN;
const winRate = (a: number[]) => a.length ? a.filter(x => x > 0).length / a.length * 100 : NaN;

function summarize(rows: Sample[], h: number) {
  const rets = rows.map(r => r.ret[h]).filter(x => x != null && !isNaN(x));
  const exc  = rows.map(r => r.excess[h]).filter(x => x != null && !isNaN(x));
  const avgRet = mean(rets);
  const avgExc = mean(exc);
  const netExc = avgExc - ROUND_TRIP_PCT; // 扣來回成本
  return {
    n: rets.length,
    avgRet: +avgRet.toFixed(2),
    win: +winRate(rets).toFixed(1),
    avgExc: +avgExc.toFixed(2),
    netExc: +netExc.toFixed(2),
  };
}

function splitTrainTest(rows: Sample[]): { train: Sample[]; test: Sample[]; cut: string } {
  const sorted = [...rows].sort((a, b) => a.date.localeCompare(b.date));
  const cut = sorted.length ? sorted[Math.floor(sorted.length / 2)].date : '';
  return {
    train: sorted.filter(r => r.date < cut),
    test: sorted.filter(r => r.date >= cut),
    cut,
  };
}

// ── 輸出 ────────────────────────────────────────────────────────────────────
const elapsed = ((Date.now() - t0) / 1000).toFixed(0);
console.log(`\n=== 進場-14 一字底窄幅門檻回測（${START} ~ ${END}）===`);
console.log(`掃描 ${scanned} 檔 / 來回成本 ${ROUND_TRIP_PCT.toFixed(3)}% / 耗時 ${elapsed}s\n`);

for (const v of VARIANTS) {
  const rows = samples[v.label];
  console.log(`【${v.label}】候選 ${rows.length} 筆`);
  console.log('  期別  H   n     平均報酬%  勝率%   平均超額%  淨超額%');
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

// 直接對照 d20（最常用的中線視窗）train/test
console.log('=== 兩變體 d20 對照（北極星：淨超額 + train/test 一致）===');
console.log('  變體        期別        n     平均報酬%  勝率%   淨超額%');
for (const v of VARIANTS) {
  const { train, test, cut } = splitTrainTest(samples[v.label]);
  for (const [name, seg] of [[`train<${cut}`, train], [`test≥${cut}`, test]] as Array<[string, Sample[]]>) {
    const s = summarize(seg, 20);
    console.log(`  ${v.label.padEnd(10)} ${name.padEnd(12)} ${String(s.n).padStart(5)}  ${String(s.avgRet).padStart(8)}  ${String(s.win).padStart(6)}  ${String(s.netExc).padStart(7)}`);
  }
}
console.log('');
