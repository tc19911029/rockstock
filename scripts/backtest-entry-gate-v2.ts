/**
 * Entry-Gate Backtest v2 — 加 maxDrawdown + regime-aware thresholds + 用 scan 歷史
 *
 * 樣本來源：data/scan-TW-long-daily-{date}.json（post_close 一個月+）
 * 為什麼換掉 v1 的 youtube analysis：v1 樣本只有 5/18 起 8 天，不夠 robust。
 *
 * 對每檔 scan candidate：
 *   1. 算 as-of date 的 marketRegime（^TWII）+ 對應 thresholds
 *   2. computeEntryState → 分 can_enter / watch / no_chase
 *   3. forward N 日 close vs base close → forward return
 *   4. 進場後 N 日內 min(low) vs base close → max drawdown（這才是「進去後最深的痛」）
 *
 * 輸出：
 *   - data/agents/backtest/entry-gate-v2.json
 *   - console table：每組 count / 勝率 / 平均 R / 平均 maxDD / R/maxDD ratio
 *
 * Usage:
 *   FROM=2026-04-23 TO=2026-05-20 HOLD_DAYS=5 npx tsx scripts/backtest-entry-gate-v2.ts
 */

import fs from 'fs';
import path from 'path';
import type { Candle } from '@/types';
import { computeEntryState, type EntryState } from '@/lib/agents/entryGate';
import { detectMarketRegime, thresholdsForRegime, type MarketRegime } from '@/lib/agents/marketRegime';

const DATA_DIR = path.join(process.cwd(), 'data');
const CANDLE_DIR = path.join(DATA_DIR, 'candles', 'TW');
const OUT_PATH = path.join(DATA_DIR, 'agents', 'backtest', 'entry-gate-v2.json');

const FROM = process.env.FROM ?? '2026-04-23';
const TO = process.env.TO ?? '';
const HOLD_DAYS = Number(process.env.HOLD_DAYS ?? 5);
const MIN_FORWARD_DAYS = Number(process.env.MIN_FORWARD_DAYS ?? HOLD_DAYS);

interface ScanFile { results?: Array<{ symbol: string; name?: string; finalScore?: number }> }
interface CandleFile { candles: Candle[] }

interface Sample {
  date: string;
  code: string;
  name: string;
  regime: MarketRegime;
  state: EntryState;
  baseClose: number;
  forwardN: number;
  forwardClose: number | null;
  forwardReturn: number | null;
  maxDrawdownPct: number | null;
  maxGainPct: number | null;
}

const candleCache = new Map<string, Candle[]>();
function loadCandles(code: string): Candle[] | null {
  if (candleCache.has(code)) return candleCache.get(code)!;
  for (const sym of [`${code}.TW`, `${code}.TWO`]) {
    const p = path.join(CANDLE_DIR, `${sym}.json`);
    if (!fs.existsSync(p)) continue;
    try {
      const f = JSON.parse(fs.readFileSync(p, 'utf8')) as CandleFile;
      if (f.candles?.length > 0) { candleCache.set(code, f.candles); return f.candles; }
    } catch { /* skip */ }
  }
  candleCache.set(code, []);
  return null;
}

const indexAll: Candle[] = (() => {
  try {
    const f = JSON.parse(fs.readFileSync(path.join(CANDLE_DIR, '^TWII.json'), 'utf8')) as CandleFile;
    return f.candles ?? [];
  } catch { return []; }
})();

function regimeForDate(date: string) {
  const slice = indexAll.filter(c => c.date <= date);
  return detectMarketRegime(slice);
}

function listScanDates(): string[] {
  const files = fs.readdirSync(DATA_DIR);
  const re = /^scan-TW-long-daily-(\d{4}-\d{2}-\d{2})\.json$/;
  const dates = files
    .map(f => f.match(re))
    .filter((m): m is RegExpMatchArray => !!m)
    .map(m => m[1])
    .filter(d => d >= FROM && (!TO || d <= TO))
    .sort();
  return [...new Set(dates)];
}

function analyzeDate(date: string): Sample[] {
  const p = path.join(DATA_DIR, `scan-TW-long-daily-${date}.json`);
  if (!fs.existsSync(p)) return [];
  const scan = JSON.parse(fs.readFileSync(p, 'utf8')) as ScanFile;
  const results = scan.results ?? [];
  const regimeResult = regimeForDate(date);
  const thresholds = thresholdsForRegime(regimeResult.regime);
  const out: Sample[] = [];

  for (const r of results) {
    const code = r.symbol.replace(/\.(TW|TWO)$/, '');
    const all = loadCandles(code);
    if (!all) continue;
    const baseIdx = all.findIndex(c => c.date === date);
    if (baseIdx < 0) continue;
    const asOf = all.slice(0, baseIdx + 1);
    if (asOf.length < 60) continue;
    const baseClose = asOf[asOf.length - 1].close;
    const gate = computeEntryState({ symbol: code, candles: asOf, thresholds });

    const forwardSlice = all.slice(baseIdx + 1, baseIdx + 1 + HOLD_DAYS);
    if (forwardSlice.length < MIN_FORWARD_DAYS) continue;
    const forwardClose = forwardSlice[forwardSlice.length - 1].close;
    const forwardReturn = (forwardClose - baseClose) / baseClose;
    const minLow = Math.min(...forwardSlice.map(c => c.low));
    const maxHigh = Math.max(...forwardSlice.map(c => c.high));
    const maxDrawdownPct = (minLow - baseClose) / baseClose;
    const maxGainPct = (maxHigh - baseClose) / baseClose;

    out.push({
      date, code, name: r.name ?? '',
      regime: regimeResult.regime, state: gate.state,
      baseClose, forwardN: forwardSlice.length, forwardClose,
      forwardReturn, maxDrawdownPct, maxGainPct,
    });
  }
  return out;
}

interface GroupStat {
  key: string;
  n: number;
  winRate: number;
  avgReturn: number;
  medianReturn: number;
  avgMaxDD: number;
  medianMaxDD: number;
  avgMaxGain: number;
  rdRatio: number;
}

function summarise(label: string, xs: Sample[]): GroupStat {
  if (xs.length === 0) return { key: label, n: 0, winRate: NaN, avgReturn: NaN, medianReturn: NaN, avgMaxDD: NaN, medianMaxDD: NaN, avgMaxGain: NaN, rdRatio: NaN };
  const rs = xs.map(s => s.forwardReturn!).filter(v => v != null);
  const dds = xs.map(s => s.maxDrawdownPct!).filter(v => v != null);
  const gains = xs.map(s => s.maxGainPct!).filter(v => v != null);
  const median = (arr: number[]) => {
    const s = [...arr].sort((a, b) => a - b);
    const m = Math.floor(s.length / 2);
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  };
  const avg = (arr: number[]) => arr.reduce((a, b) => a + b, 0) / arr.length;
  const avgR = avg(rs), avgDD = avg(dds);
  return {
    key: label, n: xs.length,
    winRate: rs.filter(v => v > 0).length / rs.length,
    avgReturn: avgR, medianReturn: median(rs),
    avgMaxDD: avgDD, medianMaxDD: median(dds),
    avgMaxGain: avg(gains),
    rdRatio: avgDD < 0 ? avgR / Math.abs(avgDD) : NaN,
  };
}

function fmtPct(n: number): string { return isNaN(n) ? '   —  ' : `${n >= 0 ? '+' : ''}${(n * 100).toFixed(1)}%`; }
function fmtRow(s: GroupStat): string {
  return `${s.key.padEnd(28)} n=${String(s.n).padStart(4)} | 勝${fmtPct(s.winRate).padStart(6)} | 平均R ${fmtPct(s.avgReturn).padStart(7)} | 中位R ${fmtPct(s.medianReturn).padStart(7)} | 平均maxDD ${fmtPct(s.avgMaxDD).padStart(7)} | 平均maxGain ${fmtPct(s.avgMaxGain).padStart(7)} | R/DD ${isNaN(s.rdRatio) ? ' —  ' : s.rdRatio.toFixed(2).padStart(5)}`;
}

function main() {
  const dates = listScanDates();
  if (dates.length === 0) {
    console.error(`No scan files in ${FROM} → ${TO || 'latest'}`);
    process.exit(1);
  }
  console.log(`\n📊 Entry-Gate Backtest v2`);
  console.log(`   Range: ${dates[0]} → ${dates[dates.length - 1]} (${dates.length} 天 scan)`);
  console.log(`   Hold ${HOLD_DAYS} 日, ^TWII regime-aware thresholds\n`);

  const all: Sample[] = [];
  for (const date of dates) {
    const xs = analyzeDate(date);
    const regime = xs[0]?.regime ?? '—';
    all.push(...xs);
    process.stdout.write(`  ${date} regime=${regime} → ${xs.length} samples\n`);
  }
  console.log(`\n總樣本：${all.length} 筆\n`);

  console.log(`--- 按 entry_state 全樣本 ---`);
  console.log(fmtRow(summarise('overall', all)));
  for (const st of ['can_enter', 'watch', 'no_chase'] as EntryState[]) {
    console.log(fmtRow(summarise(st, all.filter(s => s.state === st))));
  }

  console.log(`\n--- 按 entry_state × regime ---`);
  for (const regime of ['strong_bull', 'normal', 'bear'] as MarketRegime[]) {
    const xs = all.filter(s => s.regime === regime);
    if (xs.length === 0) continue;
    console.log(`\n[${regime}] n=${xs.length}`);
    for (const st of ['can_enter', 'watch', 'no_chase'] as EntryState[]) {
      const sub = xs.filter(s => s.state === st);
      if (sub.length > 0) console.log(fmtRow(summarise(`  ${st}`, sub)));
    }
  }

  fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true });
  fs.writeFileSync(OUT_PATH, JSON.stringify({
    generatedAt: new Date().toISOString(),
    range: { from: dates[0], to: dates[dates.length - 1], days: dates.length },
    config: { holdDays: HOLD_DAYS },
    overall: summarise('overall', all),
    byState: Object.fromEntries((['can_enter', 'watch', 'no_chase'] as EntryState[]).map(st => [st, summarise(st, all.filter(s => s.state === st))])),
    byStateAndRegime: Object.fromEntries((['strong_bull', 'normal', 'bear'] as MarketRegime[]).map(r => [r, Object.fromEntries((['can_enter', 'watch', 'no_chase'] as EntryState[]).map(st => [st, summarise(`${r}/${st}`, all.filter(s => s.regime === r && s.state === st))]))])),
    sampleCount: all.length,
  }, null, 2));
  console.log(`\n✅ Wrote ${OUT_PATH}\n`);
}

main();
