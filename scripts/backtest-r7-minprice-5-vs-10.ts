/**
 * R7-2 回測：盤中粗掃最低股價 TW 10 元 → 5 元？
 *
 * 現況 lib/scanner/CoarseScanner.ts:99 `minPrice = market === 'TW' ? 10 : 3`
 *（737aaf7 遺留、無註解、無設計理由）；盤後宇宙用 TW_UNIVERSE_MIN_PRICE = 5
 *（課程 5-2「去除股價低於 5 元」）。問題：把 5~10 元放進候選池，是稀釋還是加分？
 *
 * 兩個變體（都去 beta）：
 *  A 主測（精掃後）＝ 粗掃條件 ∩ 六條件核心5項全過 → T+1 開盤進場、
 *    D5/D20 對 ^TWII 曆日對齊超額（settleBaseline + computeEventReturns，同全站慣例）
 *  B 廣度（粗掃池本身，樣本大）＝ 橫斷面去 beta：超額 = 個股 dN − 同日粗掃池平均 dN
 *    （同 backtest-r8-inst-sell-streak.ts 的同日宇宙平均口徑）
 *
 * 粗掃條件由 CoarseScanner 逐條轉成日K等價：
 *   close ≥ minPrice、漲跌幅 ≥ −2%、量比(5日均量) ≥ 0.5、5 項加分條件 ≥ 2
 *
 * 通過條件：5~10 元帶在 train 與 test 兩段的 D5/D20 超額都 ≥ 10 元帶（不稀釋），
 *          且樣本足夠。任一段翻面 ⇒ 否決（維持 10 元）。
 *
 * Usage: FROM=2024-01-01 TO=2026-06-30 npx tsx scripts/backtest-r7-minprice-5-vs-10.ts
 */
import fs from 'fs';
import path from 'path';
import type { Candle } from '@/types';
import { computeIndicators } from '@/lib/indicators';
import { evaluateSixConditions } from '@/lib/analysis/trendAnalysis';
import { settleBaseline, type BaselineCandle } from '@/lib/backtest/eventBaseline';
import { computeEventReturns } from '@/lib/backtest/eventReturns';

const CANDLE_DIR = path.join(process.cwd(), 'data', 'candles', 'TW');
const FROM = process.env.FROM ?? '2024-01-01';
const TO = process.env.TO ?? '2026-06-30';
const NOW = '2099-12-31';

type Band = 'p5to10' | 'p10up';
interface RowA { band: Band; date: string; code: string; exD5: number | null; exD20: number | null; status: string }
interface RowB { band: Band; date: string; d5: number; d20: number }

function loadRaw(sym: string): Candle[] | null {
  const p = path.join(CANDLE_DIR, `${sym}.json`);
  if (!fs.existsSync(p)) return null;
  try {
    const f = JSON.parse(fs.readFileSync(p, 'utf8')) as { candles?: Candle[] };
    return f.candles && f.candles.length > 0 ? f.candles : null;
  } catch { return null; }
}

const idxRaw = loadRaw('^TWII');
if (!idxRaw) { console.error('缺 ^TWII'); process.exit(1); }
const indexCandles = idxRaw as unknown as BaselineCandle[];

const files = fs.readdirSync(CANDLE_DIR).filter(f => f.endsWith('.json') && !f.startsWith('^'));
const rowsA: RowA[] = [];
const rowsB: RowB[] = [];
let scanned = 0;

for (const file of files) {
  const sym = file.replace(/\.json$/, '');
  const raw = loadRaw(sym);
  if (!raw || raw.length < 80) continue;
  const enriched = computeIndicators(raw);
  const baseCandles = raw as unknown as BaselineCandle[];

  for (let i = 60; i + 20 < enriched.length; i++) {
    const c = enriched[i];
    if (c.date < FROM || c.date > TO) continue;
    const prev = enriched[i - 1];
    if (!prev || prev.close <= 0 || c.close <= 0) continue;

    // ── 粗掃條件（CoarseScanner 日K等價）──
    if (c.close < 5) continue;                                   // 放寬後的下界
    const changePct = (c.close - prev.close) / prev.close * 100;
    if (changePct < -2) continue;                                // minChangePercent
    const vol5 = enriched.slice(i - 4, i + 1).reduce((s, x) => s + (x.volume || 0), 0) / 5;
    const volumeRatio = vol5 > 0 ? (c.volume || 0) / vol5 : 0;
    if (volumeRatio < 0.5 && vol5 > 0) continue;                 // minVolumeRatio
    const ma5 = c.ma5 ?? 0, ma10 = c.ma10 ?? 0, ma20 = c.ma20 ?? 0;
    let score = 0;
    if (ma20 > 0 && c.close > ma20) score++;
    if (ma5 > 0 && ma20 > 0 && ma5 > ma20) score++;
    if (volumeRatio >= 1) score++;
    if (changePct > 0) score++;
    if (ma5 > 0 && ma10 > 0 && ma20 > 0 && ma5 > ma10 && ma10 > ma20) score++;
    if (score < 2) continue;

    const band: Band = c.close < 10 ? 'p5to10' : 'p10up';

    // 變體 B：粗掃池本身（橫斷面去 beta，raw 前瞻 close-to-close）
    rowsB.push({
      band, date: c.date,
      d5: (enriched[i + 5].close / c.close - 1) * 100,
      d20: (enriched[i + 20].close / c.close - 1) * 100,
    });

    // 變體 A：再過六條件核心 5 項（＝真的會被選出來的）
    const r = evaluateSixConditions(enriched, i);
    if (!r.isCoreReady) continue;
    const baseline = settleBaseline(c.date, baseCandles, NOW);
    const ret = computeEventReturns({ baseline }, baseCandles, indexCandles);
    rowsA.push({
      band, date: c.date, code: sym,
      exD5: ret?.excess.d5 ?? null,
      exD20: ret?.excess.d20 ?? null,
      status: baseline.status,
    });
  }
  scanned++;
  if (scanned % 300 === 0) console.error(`  ...scanned ${scanned}/${files.length}, A=${rowsA.length} B=${rowsB.length}`);
}

// ── 變體 A 報表 ──────────────────────────────────────────────────────────────
const datesA = [...new Set(rowsA.map(r => r.date))].sort();
const splitA = datesA[Math.floor(datesA.length / 2)] ?? TO;
function statA(rs: RowA[], h: 'exD5' | 'exD20') {
  const f = rs.filter(r => r.status === 'filled' && r[h] != null);
  const v = f.map(r => r[h]!);
  const n = v.length;
  return { n, mean: n ? v.reduce((a, b) => a + b, 0) / n : NaN, win: n ? f.filter(r => r[h]! > 0).length / n : NaN };
}
console.log(`\n📊 R7-2 粗掃 minPrice 10 → 5 回測  ${FROM} → ${TO}（掃 ${scanned} 檔）`);
console.log(`\n═══ 變體 A：粗掃 ∩ 六條件核心5項（實際選出來的股）；超額對 ^TWII，T+1 開盤進場 ═══`);
console.log(`母體 ${rowsA.length} 筆；train/test 切點 ${splitA}`);
for (const band of ['p5to10', 'p10up'] as Band[]) {
  const all = rowsA.filter(r => r.band === band);
  const noFill = all.filter(r => r.status === 'no_fill').length;
  console.log(`\n── ${band === 'p5to10' ? '5~10 元（改了才會納入）' : '≥10 元（現況已納入）'} ── n=${all.length}，no_fill ${noFill}`);
  for (const [lbl, rs] of [['train', all.filter(r => r.date <= splitA)], ['test ', all.filter(r => r.date > splitA)]] as const) {
    const d5 = statA(rs, 'exD5'), d20 = statA(rs, 'exD20');
    console.log(`   ${lbl}: D5 超額 ${d5.mean.toFixed(2)}% 勝率 ${(100 * d5.win).toFixed(0)}% (n=${d5.n}) | D20 超額 ${d20.mean.toFixed(2)}% 勝率 ${(100 * d20.win).toFixed(0)}% (n=${d20.n})`);
  }
}

// ── 變體 B 報表（橫斷面去 beta：減同日粗掃池平均）─────────────────────────────
const dayMean = new Map<string, { s5: number; s20: number; n: number }>();
for (const r of rowsB) {
  const m = dayMean.get(r.date) ?? { s5: 0, s20: 0, n: 0 };
  m.s5 += r.d5; m.s20 += r.d20; m.n++;
  dayMean.set(r.date, m);
}
const exB = (r: RowB, h: 5 | 20) => {
  const m = dayMean.get(r.date)!;
  return h === 5 ? r.d5 - m.s5 / m.n : r.d20 - m.s20 / m.n;
};
const datesB = [...new Set(rowsB.map(r => r.date))].sort();
const splitB = datesB[Math.floor(datesB.length / 2)] ?? TO;
console.log(`\n═══ 變體 B：粗掃池本身（樣本大）；超額 = 減同日粗掃池平均（橫斷面去 beta）═══`);
console.log(`母體 ${rowsB.length} 筆；train/test 切點 ${splitB}`);
for (const band of ['p5to10', 'p10up'] as Band[]) {
  const all = rowsB.filter(r => r.band === band);
  console.log(`\n── ${band === 'p5to10' ? '5~10 元' : '≥10 元'} ── n=${all.length}（佔池 ${(100 * all.length / rowsB.length).toFixed(1)}%）`);
  for (const [lbl, rs] of [['train', all.filter(r => r.date <= splitB)], ['test ', all.filter(r => r.date > splitB)]] as const) {
    const e5 = rs.map(r => exB(r, 5)), e20 = rs.map(r => exB(r, 20));
    const m = (a: number[]) => a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN;
    const w = (a: number[]) => a.length ? 100 * a.filter(x => x > 0).length / a.length : NaN;
    console.log(`   ${lbl}: D5 超額 ${m(e5).toFixed(2)}% 勝率 ${w(e5).toFixed(0)}% | D20 超額 ${m(e20).toFixed(2)}% 勝率 ${w(e20).toFixed(0)}% (n=${rs.length})`);
  }
}
console.log(`\n判定：放寬到 5 元要成立 ⇒ 5~10 元帶在 train 與 test 兩段的 D5/D20 超額都不遜於 ≥10 元帶。`);
