/**
 * 「超跌反彈」深驗 — 確認這是真 alpha 不是雜訊/偏誤。全市場主板 L1。
 *
 * ①參數掃描：離 MA20 跌 T% 觸發（T=8/12/15/20/25/30），看「越深越強」是否單調（單調=可信）。
 * ②每日可選檔數：典型一天有幾檔達標（夠不夠選）。③持有天期 d5/d20/d40/d60。
 * train(<2024-09)/test(≥) 分半。報酬 raw（與隨機基準比已控市場；隨機基準另列）。
 *
 * 用法：npx tsx scripts/research-cn-oversold.ts
 */
import fs from 'fs';
import path from 'path';
import { settleBaseline, type BaselineCandle } from '@/lib/backtest/eventBaseline';
import { computeEventReturns } from '@/lib/backtest/eventReturns';

const DIR = path.join(process.cwd(), 'data', 'candles', 'CN');
const NOW = new Date().toISOString();
const CUT = '2024-09-01';
const INDEX = new Set(['000001.SS', '000300.SS', '000016.SS', '000905.SS', '000852.SS', '000010.SS', '000009.SS', '000688.SS']);
const isIndex = (s: string) => INDEX.has(s) || s.startsWith('399') || s.startsWith('899');
const ma = (c: number[], n: number, i: number) => { if (i < n - 1) return null; let s = 0; for (let k = i - n + 1; k <= i; k++) s += c[k]; return s / n; };
const med = (a: number[]) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
const avg = (a: number[]) => (a.length ? a.reduce((x, v) => x + v, 0) / a.length : null);
const pct = (v: number | null) => (v == null ? ' — ' : `${v >= 0 ? '+' : ''}${v.toFixed(1)}%`);
const win = (a: number[]) => (a.length ? Math.round(a.filter((v) => v > 0).length / a.length * 100) : 0);

const THRESH = [0.08, 0.12, 0.15, 0.20, 0.25, 0.30];
type Row = { d5: number | null; d20: number | null; d40: number | null; d60: number | null; date: string };
const byThresh: Record<string, Row[]> = {};
const condDays: Record<string, number> = {}; // 達標 stock-day 數（算每日可選檔數）
for (const t of THRESH) { byThresh[t] = []; condDays[t] = 0; }
const allDates = new Set<string>();
const rnd: Row[] = [];

// d40 不在 RECO_HORIZON，自己用 i0 算
function d40(bars: BaselineCandle[], baseDate: string, entryOpen: number): number | null {
  const i0 = bars.findIndex((b) => b.date === baseDate);
  if (i0 < 0) return null; const c = bars[i0 + 39]; return c ? +(((c.close - entryOpen) / entryOpen) * 100).toFixed(2) : null;
}

const files = fs.readdirSync(DIR).filter((f) => f.endsWith('.json'));
let processed = 0;
for (const f of files) {
  const sym = f.replace('.json', '');
  if (isIndex(sym)) continue;
  let bars: BaselineCandle[];
  try { bars = (JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8')).candles ?? []) as BaselineCandle[]; } catch { continue; }
  if (bars.length < 90) continue;
  const close = bars.map((b) => b.close);
  const ev = (i: number): Row | null => {
    const b = settleBaseline(bars[i].date, bars, NOW);
    if (b.status !== 'filled' || b.entry_open == null) return null;
    const r = computeEventReturns({ baseline: b }, bars, null);
    return r ? { d5: r.d5, d20: r.d20, d40: d40(bars, b.base_date!, b.entry_open), d60: r.d60, date: bars[i].date } : null;
  };
  for (let i = 60; i < bars.length - 1; i++) {
    allDates.add(bars[i].date);
    const m20 = ma(close, 20, i)!, m20b = ma(close, 20, i - 1)!;
    const dep = (m20 - close[i]) / m20, depB = (m20b - close[i - 1]) / m20b;
    for (const t of THRESH) {
      if (dep > t) condDays[t]++;            // 達標檔數（含連續）
      if (dep > t && !(depB > t)) {           // 首次跌破門檻 = 觸發
        const r = ev(i); if (r) byThresh[t].push(r);
      }
    }
    if (i % 25 === 0) { const r = ev(i); if (r) rnd.push(r); }
  }
  processed++;
}

const nDays = allDates.size;
function show(rows: Row[]) {
  const sp = (test: boolean) => rows.filter((r) => (r.date >= CUT) === test);
  const line = (rs: Row[]) => {
    const g = (k: keyof Row) => rs.map((r) => r[k]).filter((v): v is number => typeof v === 'number');
    return `d5中${pct(med(g('d5')))} d20中${pct(med(g('d20')))}/勝${win(g('d20'))}% d40中${pct(med(g('d40')))} d60中${pct(med(g('d60')))}/均${pct(avg(g('d60')))}`;
  };
  console.log(`    train: ${line(sp(false))}  (n${sp(false).length})`);
  console.log(`    test : ${line(sp(true))}  (n${sp(true).length})`);
}

console.log(`處理 ${processed} 檔、${nDays} 交易日。CUT=${CUT}\n`);
console.log('=== 參數掃描：離 MA20 跌 T% 觸發（看越深越強是否單調）===');
for (const t of THRESH) {
  console.log(`【跌破 ${(t * 100).toFixed(0)}%】每日約 ${(condDays[t] / nDays).toFixed(0)} 檔達標`);
  show(byThresh[t]);
}
console.log('\n=== 隨機基準（市場平均）===');
show(rnd);
