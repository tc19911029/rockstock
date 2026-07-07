/**
 * 逐字-13 回測：均線糾結突破「隔日補買」值不值得做？
 *
 * 課程 CH3-5：糾結突破第一天沒買到，第二天沒大漲（小漲）還可以買。
 * 現行 rockstock 只在突破當日發訊。此腳本比對：
 *   - T1（現行）：糾結突破日 T → T+1 開盤進場
 *   - T2（逐字-13 補買）：T+1「沒大漲」（0 < 當日漲幅 < 4%、非漲停）→ T+2 開盤補買
 * 都用 settleBaseline（含一字板 no_fill）+ computeEventReturns（D5/D20 對 ^TWII 超額），train/test 中位切。
 * 決策：T2 要淨超額為正 + train/test 一致 + 不遜於 T1，才建議做隔日補買（QA#12 平盤補買前例＝否決）。
 *
 * Usage: FROM=2024-01-01 TO=2026-06-30 npx tsx scripts/backtest-cluster-nextday-buy.ts
 */
import fs from 'fs';
import path from 'path';
import type { Candle } from '@/types';
import { computeIndicators } from '@/lib/indicators';
import { isLimitUp } from '@/lib/utils/limitRules';
import { settleBaseline, type BaselineCandle } from '@/lib/backtest/eventBaseline';
import { computeEventReturns } from '@/lib/backtest/eventReturns';

const CANDLE_DIR = path.join(process.cwd(), 'data', 'candles', 'TW');
const FROM = process.env.FROM ?? '2024-01-01';
const TO = process.env.TO ?? '2026-06-30';
const NOW = '2099-12-31';

interface Row { cohort: 'T1' | 'T2'; date: string; exD5: number | null; exD20: number | null; status: string; }

function loadRaw(sym: string): Candle[] | null {
  const p = path.join(CANDLE_DIR, `${sym}.json`);
  if (!fs.existsSync(p)) return null;
  try { const f = JSON.parse(fs.readFileSync(p, 'utf8')) as { candles?: Candle[] }; return f.candles?.length ? f.candles : null; } catch { return null; }
}

const idxRaw = loadRaw('^TWII');
const indexCandles = (idxRaw as unknown as BaselineCandle[]) ?? null;
if (!indexCandles) { console.error('缺 ^TWII'); process.exit(1); }

const files = fs.readdirSync(CANDLE_DIR).filter(f => /^\d{4}\.TW\.json$/.test(f));
const rows: Row[] = [];
let scanned = 0;

for (const file of files) {
  const sym = file.replace(/\.json$/, '');
  const raw = loadRaw(sym);
  if (!raw || raw.length < 80) continue;
  const en = computeIndicators(raw);
  const base = raw as unknown as BaselineCandle[];

  for (let i = 60; i < en.length - 1; i++) {
    const c = en[i];
    if (c.date < FROM || c.date > TO) continue;
    const prev = en[i - 1];
    const { ma5, ma10, ma20 } = c;
    if (ma5 == null || ma10 == null || ma20 == null || prev?.ma20 == null) continue;
    // 均線糾結：MA5/10/20 前一日帶寬 < 2%（貼合），今日紅K收盤突破三線最高
    const band = Math.max(prev.ma5 ?? 0, prev.ma10 ?? 0, prev.ma20) - Math.min(prev.ma5 ?? 1e9, prev.ma10 ?? 1e9, prev.ma20);
    const clusterTight = prev.ma20 > 0 && band / prev.ma20 < 0.02;
    const breakoutUp = c.close > c.open && c.close > Math.max(ma5, ma10, ma20);
    if (!(clusterTight && breakoutUp)) continue;

    // T1：突破日 → T+1 開盤進
    const b1 = settleBaseline(c.date, base, NOW);
    const r1 = computeEventReturns({ baseline: b1 }, base, indexCandles);
    rows.push({ cohort: 'T1', date: c.date, exD5: r1?.excess.d5 ?? null, exD20: r1?.excess.d20 ?? null, status: b1.status });

    // T2（逐字-13）：T+1「沒大漲」（0 < 當日漲幅 < 4%、非漲停）→ T+2 開盤補買（= settle on T+1）
    const n1 = en[i + 1];
    if (n1 && prev) {
      const chg = c.close > 0 ? (n1.close - c.close) / c.close : 0;
      const notBigUp = chg > 0 && chg < 0.04 && !isLimitUp(n1.close, c.close, 'TW', sym);
      if (notBigUp) {
        const b2 = settleBaseline(n1.date, base, NOW);
        const r2 = computeEventReturns({ baseline: b2 }, base, indexCandles);
        rows.push({ cohort: 'T2', date: c.date, exD5: r2?.excess.d5 ?? null, exD20: r2?.excess.d20 ?? null, status: b2.status });
      }
    }
  }
  scanned++;
  if (scanned % 400 === 0) console.error(`  ...${scanned}/${files.length}, ${rows.length} rows`);
}

const dates = [...new Set(rows.map(r => r.date))].sort();
const split = dates[Math.floor(dates.length / 2)] ?? TO;

function stat(rs: Row[], h: 'exD5' | 'exD20') {
  const f = rs.filter(r => r.status === 'filled' && r[h] != null);
  const v = f.map(r => r[h]!);
  const n = v.length;
  return { n, mean: n ? v.reduce((a, b) => a + b, 0) / n : NaN, win: n ? f.filter(r => r[h]! > 0).length / n : NaN };
}
function report(cohort: 'T1' | 'T2') {
  const all = rows.filter(r => r.cohort === cohort);
  const noFill = all.filter(r => r.status === 'no_fill').length;
  console.log(`\n── ${cohort === 'T1' ? 'T1 突破當日→T+1進（現行）' : 'T2 隔日沒大漲→T+2補買（逐字-13）'} ──  命中 ${all.length}、一字買不到 ${noFill}`);
  for (const [lbl, rs] of [['train', all.filter(r => r.date <= split)], ['test', all.filter(r => r.date > split)]] as const) {
    const d5 = stat(rs, 'exD5'), d20 = stat(rs, 'exD20');
    console.log(`   ${lbl}: D5 超額 ${d5.mean.toFixed(2)}% 勝率 ${(100 * d5.win).toFixed(0)}% (n=${d5.n}) | D20 超額 ${d20.mean.toFixed(2)}% 勝率 ${(100 * d20.win).toFixed(0)}% (n=${d20.n})`);
  }
}
console.log(`\n📊 逐字-13 糾結突破隔日補買回測  ${FROM}→${TO}｜掃 ${scanned} 檔、${rows.length} 筆、切點 ${split}`);
report('T1');
report('T2');
console.log(`\n決策：T2（隔日補買）要 D5/D20 超額 train/test 皆正 + 不遜於 T1，才建議做；否則沿用只在突破日發訊（QA#12 平盤補買前例＝否決）。`);
