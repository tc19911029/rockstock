/**
 * 純技術/趨勢選股 歷史回測（不靠 cn-agents 空訊號，直接用 L1 日K）。
 *
 * 全市場主板 L1（data/candles/CN/*.json）。4 種設置在「觸發日 T」進場（隔日開盤、沿用
 * settleBaseline 的一字 no_fill/停牌守衛），算事後 d5/d20/d60 報酬，對照「全市場隨機進場」基準
 * （= 同期同宇宙的市場平均），train(舊)/test(新) 分半。設置報酬 >> 隨機基準 = 有選股 alpha。
 *
 * 設置：
 *   多頭啟動  close>MA5>MA10>MA20 且 MA20 上彎 且 不追高(離MA20<15%)，剛成立那天
 *   突破前高  close 站上前 20 日高、非漲停(<9.5%)、且站上 MA20，突破那天
 *   回踩守均  多頭中 low 觸 MA20 但收在 MA20 上（縮腳守住），首次回踩那天
 *   追高對照  close 高於 MA20 逾 20%（追高/過熱）→ 預期會輸（驗證「別追」）
 *
 * 用法：npx tsx scripts/research-cn-trend.ts
 */
import fs from 'fs';
import path from 'path';
import { settleBaseline, type BaselineCandle } from '@/lib/backtest/eventBaseline';
import { computeEventReturns } from '@/lib/backtest/eventReturns';
import { classifyCnBoard } from '@/lib/cn-agents/cnBoard';

const DIR = path.join(process.cwd(), 'data', 'candles', 'CN');
const NOW = new Date().toISOString();
const CUT = '2024-09-01'; // train < CUT / test ≥ CUT
const INDEX = new Set(['000001.SS', '000300.SS', '000016.SS', '000905.SS', '000852.SS', '000010.SS', '000009.SS', '000688.SS']);
const isIndex = (sym: string) => INDEX.has(sym) || sym.startsWith('399') || sym.startsWith('899');

const ma = (c: number[], n: number, i: number) => { if (i < n - 1) return null; let s = 0; for (let k = i - n + 1; k <= i; k++) s += c[k]; return s / n; };

type Row = { d5: number | null; d20: number | null; d60: number | null; date: string };
const setups: Record<string, Row[]> = { 多頭啟動: [], 突破前高: [], 回踩守均: [], 追高對照: [], 超跌離均: [], 急跌止穩: [], 超跌且多頭: [], 隨機基準: [] };

const files = fs.readdirSync(DIR).filter((f) => f.endsWith('.json'));
let processed = 0;
for (const f of files) {
  const sym = f.replace('.json', '');
  if (isIndex(sym)) continue;
  let bars: BaselineCandle[];
  try { bars = (JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8')).candles ?? []) as BaselineCandle[]; } catch { continue; }
  if (bars.length < 90) continue;
  const board = classifyCnBoard(sym.split('.')[0]);
  const close = bars.map((b) => b.close);
  const fire = (i: number, key: string) => {
    const baseline = settleBaseline(bars[i].date, bars, NOW);
    if (baseline.status !== 'filled') return; // 一字/停牌/無資料 不計
    const r = computeEventReturns({ baseline }, bars, null); // raw（不算超額，跟隨機基準比已控市場）
    if (r) setups[key].push({ d5: r.d5, d20: r.d20, d60: r.d60, date: bars[i].date });
  };

  for (let i = 60; i < bars.length - 1; i++) {
    const m5 = ma(close, 5, i)!, m10 = ma(close, 10, i)!, m20 = ma(close, 20, i)!, m20p = ma(close, 20, i - 5)!;
    const m5b = ma(close, 5, i - 1)!, m10b = ma(close, 10, i - 1)!, m20b = ma(close, 20, i - 1)!, m20pb = ma(close, 20, i - 6)!;
    const c = close[i], cb = close[i - 1];
    const aligned = c > m5 && m5 > m10 && m10 > m20 && m20 > m20p && (c - m20) / m20 < 0.15;
    const alignedB = cb > m5b && m5b > m10b && m10b > m20b && m20b > m20pb && (cb - m20b) / m20b < 0.15;
    if (aligned && !alignedB) fire(i, '多頭啟動');

    let pHi = -Infinity, pHiB = -Infinity;
    for (let k = i - 20; k < i; k++) pHi = Math.max(pHi, bars[k].high);
    for (let k = i - 21; k < i - 1; k++) pHiB = Math.max(pHiB, bars[k].high);
    if (c > pHi && c > m20 && c / cb - 1 < 0.095 && cb <= pHiB) fire(i, '突破前高');

    const upTrend = m5 > m10 && m10 > m20 && m20 > m20p;
    const touch = bars[i].low <= m20 * 1.02 && c >= m20 && c >= cb * 0.97;
    const touchB = bars[i - 1].low <= m20b * 1.02;
    if (upTrend && touch && !touchB) fire(i, '回踩守均');

    const ext = (c - m20) / m20 > 0.20, extB = (cb - m20b) / m20b > 0.20;
    if (ext && !extB) fire(i, '追高對照');

    // 超跌反彈系列（追高的鏡像）
    const dn = (m20 - c) / m20 > 0.15, dnB = (m20b - cb) / m20b > 0.15;
    if (dn && !dnB) fire(i, '超跌離均');                       // 離 MA20 跌逾 15%（過度乖離）

    const ret5 = close[i - 5] > 0 ? c / close[i - 5] - 1 : 0;
    const ret5b = close[i - 6] > 0 ? cb / close[i - 6] - 1 : 0;
    const stab = ret5 < -0.10 && c > bars[i].open && c > cb;   // 5 日跌逾 10% 後當日收紅止穩
    const stabB = ret5b < -0.10 && cb > bars[i - 1].open && cb > close[i - 2];
    if (stab && !stabB) fire(i, '急跌止穩');

    const m60 = ma(close, 60, i)!, m60b = ma(close, 60, i - 1)!;
    const dipUp = dn && c > m60 && m60 > m60b;                 // 過度乖離但仍在 MA60 上（強勢股回檔）
    const dipUpB = dnB && cb > m60b && m60b > ma(close, 60, i - 2)!;
    if (dipUp && !dipUpB) fire(i, '超跌且多頭');

    if (i % 25 === 0) fire(i, '隨機基準'); // 每 25 根抽一次 = 同宇宙同期市場平均
  }
  processed++;
}

const med = (a: number[]) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
const avg = (a: number[]) => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : null);
const pct = (v: number | null) => (v == null ? ' — ' : `${v >= 0 ? '+' : ''}${v.toFixed(1)}%`);

function show(name: string, rows: Row[]) {
  const split = (test: boolean) => rows.filter((r) => (r.date >= CUT) === test);
  for (const [lab, set] of [['train', split(false)], ['test', split(true)]] as const) {
    const g = (h: 'd5' | 'd20' | 'd60') => set.map((r) => r[h]).filter((v): v is number => v != null);
    const w = (a: number[]) => (a.length ? +(a.filter((v) => v > 0).length / a.length * 100).toFixed(0) : null);
    const d5 = g('d5'), d20 = g('d20'), d60 = g('d60');
    console.log(`  ${lab}: d5 中${pct(med(d5))} d20 中${pct(med(d20))}/均${pct(avg(d20))}/勝${w(d20) ?? '—'}% d60 中${pct(med(d60))}/均${pct(avg(d60))} (n${set.length})`);
  }
}

console.log(`處理 ${processed} 檔；CUT=${CUT}（train<CUT / test≥CUT）。報酬=raw（與「隨機基準」比已控市場漂移）\n`);
for (const name of Object.keys(setups)) { console.log(`【${name}】`); show(name, setups[name]); console.log(); }
