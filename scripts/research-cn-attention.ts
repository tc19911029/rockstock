/**
 * 「注意力」代理回測 — 用成交量爆增當散戶關注代理（alt-data 沒歷史可測，量是唯一有歷史的關注訊號）。
 * 全市場主板 L1，觸發日隔日開盤進場(settleBaseline)，事後 d20/d60，對「隨機基準」比，train/test。
 *
 * 假設（規格 Step 11/12 情緒）：早期關注(量增但價還沒動)=好；過熱(爆量大漲/追)=壞。
 * 設置：量增價穩 / 量增價漲 / 爆量(>3x) / 量縮(低關注,對照) / 量增超跌(關注+被打趴)
 * 量用「對自身 20 日均量」比值（單位污染在比值中相消）。
 *
 * 用法：npx tsx scripts/research-cn-attention.ts
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
const ma = (a: number[], n: number, i: number) => { if (i < n) return null; let s = 0; for (let k = i - n; k < i; k++) s += a[k]; return s / n; };

type Row = { d20: number | null; d60: number | null; date: string };
const S: Record<string, Row[]> = { 量增價穩: [], 量增價漲: [], 爆量3x: [], 量縮對照: [], 量增超跌: [], 隨機基準: [] };

for (const f of fs.readdirSync(DIR).filter((x) => x.endsWith('.json'))) {
  const sym = f.replace('.json', ''); if (isIndex(sym)) continue;
  let bars: BaselineCandle[];
  try { bars = (JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8')).candles ?? []) as BaselineCandle[]; } catch { continue; }
  if (bars.length < 90) continue;
  const close = bars.map((b) => b.close), vol = bars.map((b) => b.volume ?? 0);
  const fire = (i: number, key: string) => {
    const b = settleBaseline(bars[i].date, bars, NOW); if (b.status !== 'filled') return;
    const r = computeEventReturns({ baseline: b }, bars, null);
    if (r) S[key].push({ d20: r.d20, d60: r.d60, date: bars[i].date });
  };
  for (let i = 60; i < bars.length - 1; i++) {
    const av = ma(vol, 20, i); if (!av || av <= 0) continue;
    const vr = vol[i] / av;                       // 量比
    const chg = (close[i] - close[i - 1]) / close[i - 1] * 100;
    const m20 = ma(close, 20, i)!;
    const dep = (m20 - close[i]) / m20;            // 離 MA20 跌幅
    const vrB = ma(vol, 20, i - 1) ? vol[i - 1] / ma(vol, 20, i - 1)! : 0;
    const surge = vr > 2 && !(vrB > 2);            // 首次量增（防連續重複）
    if (surge && Math.abs(chg) < 3) fire(i, '量增價穩');
    if (surge && chg > 5) fire(i, '量增價漲');
    if (vr > 3 && !(vrB > 3)) fire(i, '爆量3x');
    if (vr < 0.5 && !(vrB < 0.5)) fire(i, '量縮對照');
    if (surge && dep > 0.10) fire(i, '量增超跌');   // 量增 + 已被打趴
    if (i % 25 === 0) fire(i, '隨機基準');
  }
}

const med = (a: number[]) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
const win = (a: number[]) => (a.length ? Math.round(a.filter((v) => v > 0).length / a.length * 100) : 0);
const pct = (v: number | null) => (v == null ? ' — ' : `${v >= 0 ? '+' : ''}${v.toFixed(1)}%`);
console.log(`CUT=${CUT}。d20/d60 raw（與隨機基準比已控市場）\n`);
for (const k of Object.keys(S)) {
  const sp = (t: boolean) => S[k].filter((r) => (r.date >= CUT) === t);
  const line = (rs: Row[]) => { const d20 = rs.map((r) => r.d20).filter((v): v is number => v != null), d60 = rs.map((r) => r.d60).filter((v): v is number => v != null); return `d20中${pct(med(d20))}/勝${win(d20)}% d60中${pct(med(d60))} (n${rs.length})`; };
  console.log(`【${k}】\n  train ${line(sp(false))}\n  test  ${line(sp(true))}`);
}
