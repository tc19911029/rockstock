/**
 * 楊雲翔「特殊 EMA 區間濾網」— 30 分K 版（他的原汁原味週期）。
 * 但台股分鐘K無封存、Fugle 歷史僅回看 ~3 個月 → 樣本薄，只能看「訊號長怎樣/密度/賺賠形狀」，
 * 無法統計判斷淨 alpha（要判 alpha 看 backtest-yang-ema-filter.ts 日K長歷史版）。
 *
 * 規則同日K版：EMA23（此處=23 根 30分K）、收盤穿越 ±1%/±3% 濾網、隔一根開盤進出、long/flat 波段。
 * universe = 用現有日K檔挑「近60日成交額中位數」前 N 大，再逐檔抓 30 分K。
 */
import { promises as fs } from 'fs';
import path from 'path';
import { getFugleHistoricalMinuteCandles } from '../lib/datasource/FugleProvider';

const C = path.join(process.cwd(), 'data/candles/TW');
const COST = 0.006, EMA_N = 23, TOP_N = 100;

interface OHLC { date: string; open: number; high: number; low: number; close: number; volume: number }
async function readJ(p: string): Promise<any> { try { return JSON.parse(await fs.readFile(p, 'utf8')); } catch { return null; } }
function ema(vals: number[], n: number): number[] { const k = 2 / (n + 1); const out: number[] = []; let prev = vals[0]; for (let i = 0; i < vals.length; i++) { prev = i === 0 ? vals[0] : vals[i] * k + prev * (1 - k); out[i] = prev; } return out; }

function runFilter(cs: OHLC[], b1: number, b3: number): { retNet: number; bars: number }[] {
  const out: { retNet: number; bars: number }[] = [];
  if (cs.length < EMA_N + 5) return out;
  const e = ema(cs.map(c => c.close), EMA_N);
  let inPos = false, entryIdx = -1;
  const longSig = (i: number) => cs[i].close >= e[i] * (1 + b3) || (i >= 1 && cs[i].close >= e[i] * (1 + b1) && cs[i - 1].close >= e[i - 1] * (1 + b1));
  const exitSig = (i: number) => cs[i].close <= e[i] * (1 - b3) || (i >= 1 && cs[i].close <= e[i] * (1 - b1) && cs[i - 1].close <= e[i - 1] * (1 - b1));
  for (let i = EMA_N; i < cs.length - 1; i++) {
    if (!inPos) { if (longSig(i)) { inPos = true; entryIdx = i + 1; } }
    else if (exitSig(i)) { const ex = i + 1; out.push({ retNet: (cs[ex].open / cs[entryIdx].open - 1) * 100 - COST * 100, bars: ex - entryIdx }); inPos = false; }
  }
  if (inPos) { const last = cs.length - 1; out.push({ retNet: (cs[last].close / cs[entryIdx].open - 1) * 100 - COST * 100, bars: last - entryIdx }); }
  return out;
}

function report(label: string, ts: { retNet: number; bars: number }[]) {
  if (!ts.length) { console.log(`  ${label}: 無交易`); return; }
  const n = ts.length, wins = ts.filter(t => t.retNet > 0), losses = ts.filter(t => t.retNet <= 0);
  const avg = (a: number[]) => a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0;
  console.log(`  ${label}: ${n} 筆  賺機率 ${(wins.length / n * 100).toFixed(1)}%  平均賺 +${avg(wins.map(t => t.retNet)).toFixed(2)}%  平均賠 ${avg(losses.map(t => t.retNet)).toFixed(2)}%`);
  console.log(`    每筆期望(淨,含大盤beta) ${avg(ts.map(t => t.retNet)) >= 0 ? '+' : ''}${avg(ts.map(t => t.retNet)).toFixed(2)}%  平均抱 ${(avg(ts.map(t => t.bars)) / 10).toFixed(1)} 天(≈${avg(ts.map(t => t.bars)).toFixed(0)}根30分K)`);
}

async function main() {
  // 用日K挑近60日成交額前 TOP_N
  const files = (await fs.readdir(C)).filter(f => f.endsWith('.TW.json') && !f.startsWith('^'));
  const ranked: { sym: string; med: number }[] = [];
  for (const f of files) {
    const j = await readJ(path.join(C, f)); const cs: OHLC[] = j?.candles;
    if (!cs || cs.length < 60) continue;
    const t = cs.slice(-60).map(c => c.close * (c.volume || 0) * 1000).filter(x => x > 0).sort((a, b) => a - b);
    if (!t.length) continue;
    ranked.push({ sym: f.replace('.TW.json', ''), med: t[Math.floor(t.length / 2)] });
  }
  ranked.sort((a, b) => b.med - a.med);
  const picks = ranked.slice(0, TOP_N);
  console.log(`挑近60日成交額前 ${picks.length} 大，逐檔抓 30 分K（3個月）…\n`);

  const yang: { retNet: number; bars: number }[] = [];
  const plain: { retNet: number; bars: number }[] = [];
  let ok = 0, empty = 0;
  for (const p of picks) {
    let cs = await getFugleHistoricalMinuteCandles(p.sym, '30m', '3mo');
    if (!cs.length) { empty++; continue; }
    cs = [...cs].sort((a, b) => a.date.localeCompare(b.date)); // Fugle 回傳降序 → 轉升序
    ok++;
    yang.push(...runFilter(cs as OHLC[], 0.01, 0.03));
    plain.push(...runFilter(cs as OHLC[], 0, 0));
  }
  console.log(`抓到 ${ok} 檔 / 空 ${empty} 檔\n`);
  console.log('【楊氏濾網 EMA23 ±1%/±3%（30分K）】'); report('全部', yang);
  console.log('\n【純 EMA23 交叉（30分K，無濾網對照）】'); report('全部', plain);
  console.log('\n⚠️ 僅 ~3 個月樣本，期望值含大盤beta，不能當 alpha 證據；判 alpha 看日K長歷史版。');
}
main();
