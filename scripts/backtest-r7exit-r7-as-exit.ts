/**
 * R7 當「出場訊號」的驗證（一次性腳本，不進生產）
 *
 * 書本 p.662：「趨勢呈現頭頭低的股票，且出現 MACD 或 KD 指標背離，要立刻出場」
 * rockstock 現況把它當「選股淘汰」用（lib/scanner/eliminationFilter.ts rule07）。
 * 選股側已測（backtest-r7b-elim-r7-nolowerhighs.ts）：被淘汰的之後 D20 +0.21%，沒抓到弱股。
 * 本腳本補測「出場側」：訊號當天收盤出場 vs 不理它繼續抱。
 *
 * 判定以「賠少」為主（北極星）：平均虧損幅度 / P5 / P1 / 最差一筆 / MAE(區間最大回撤) / 勝率，
 * 平均報酬與期望值輔助。
 *
 * 紀律：
 *  - 二次去 beta：先減 ^TWII，再減「同日宇宙平均」（等權宇宙 vs 市值權有 −1% 規模偏差）
 *  - train/test 依日期對半切，兩段方向一致才算過關
 *  - 樣本 <100 標樣本不足
 *  - 報酬起算＝訊號當天收盤（出場/不出場在此之前完全相同）
 *
 * 三個拆解組回答「哪一半在做事」：LH-only / DIV-only / BOTH(=生產 R7)
 * 另檢查與現有出場規則（sellSignals LOWER_LOW 事件、trend=空頭）的重疊率。
 */
import { detectTrend, findPivots } from '@/lib/analysis/trendAnalysis';
import type { CandleWithIndicators } from '@/types';
import { loadStocks, loadBench, benchFwd, liquid, mean, median, tStat } from './backtest-r7b-common';

const HZ = [5, 10, 20] as const;
const FROM = '2023-04-13'; // ^TWII L1 起始

// ── 條件判定（複製自生產，唯讀不改生產）──────────────────────────────────
function divergenceOnly(cs: CandleWithIndicators[], i: number): boolean {
  if (i < 10) return false;
  const c = cs[i], p = cs[i - 5];
  if (!p) return false;
  if (c.macdOSC != null && p.macdOSC != null && c.high > p.high && c.macdOSC < p.macdOSC) return true;
  if (c.kdK != null && p.kdK != null && c.high > p.high && c.kdK < p.kdK) return true;
  return false;
}
function lowerHighs(cs: CandleWithIndicators[], i: number): boolean {
  if (detectTrend(cs, i) === '空頭') return true;
  const pv = findPivots(cs, i, 8, false).filter(p => p.type === 'high');
  return pv.length >= 2 && pv[0].price < pv[1].price;
}
/** sellSignals.ts 第3條 LOWER_LOW 的事件型觸發（原樣複製判定，供重疊率統計） */
function sellLowerLowEvent(cs: CandleWithIndicators[], index: number): boolean {
  if (index < 10) return false;
  const highs: { idx: number; price: number }[] = [];
  for (let i = index - 1; i >= Math.max(1, index - 20) && highs.length < 3; i--) {
    if (cs[i].high > cs[i - 1].high && cs[i].high > cs[i + 1].high) highs.push({ idx: i, price: cs[i].high });
  }
  if (highs.length < 2) return false;
  const [nw, od] = highs;
  if (!(nw.price < od.price)) return false;
  for (let i = nw.idx + 1; i <= index; i++) if (cs[i].close < nw.price) return i === index;
  return false;
}

interface Obs {
  date: string; symbol: string;
  hold: boolean;                 // 持倉代理：收盤在 MA20 之上（還在部位裡的狀態）
  ex: Record<number, number>;    // 相對 ^TWII 超額 %
  exu: Record<number, number>;   // 相對同日宇宙平均超額 %（主判定）
  raw: Record<number, number>;   // 絕對報酬 %
  mae: Record<number, number>;   // 區間最大不利偏移 %（min(low)/close-1）
  lh: boolean; div: boolean;
  sellLL: boolean; bear: boolean;
}

function pct(xs: number[], p: number): number {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.max(0, Math.min(s.length - 1, Math.floor((p / 100) * s.length)))];
}

/** 用同日宇宙平均填 exu（第二層去 beta） */
function attachExu(universe: Obs[]): void {
  const acc = new Map<string, Record<number, { s: number; n: number }>>();
  for (const o of universe) {
    let m = acc.get(o.date);
    if (!m) { m = Object.fromEntries(HZ.map(h => [h, { s: 0, n: 0 }])); acc.set(o.date, m); }
    for (const h of HZ) if (Number.isFinite(o.ex[h])) { m[h].s += o.ex[h]; m[h].n++; }
  }
  for (const o of universe) {
    const m = acc.get(o.date)!;
    o.exu = Object.fromEntries(HZ.map(h => [h, m[h].n ? o.ex[h] - m[h].s / m[h].n : NaN]));
  }
}

const f = (x: number, d = 2) => (Number.isFinite(x) ? `${x >= 0 ? '+' : ''}${x.toFixed(d)}%` : '   —  ').padStart(8);

function row(label: string, rows: Obs[], h: number): string {
  const exu = rows.map(o => o.exu[h]).filter(Number.isFinite);
  const raw = rows.map(o => o.raw[h]).filter(Number.isFinite);
  const mae = rows.map(o => o.mae[h]).filter(Number.isFinite);
  const losers = exu.filter(x => x < 0);
  const wr = exu.length ? (exu.filter(x => x > 0).length / exu.length) * 100 : NaN;
  return [
    label.padEnd(14),
    String(exu.length).padStart(7),
    f(mean(exu)), tStat(exu).toFixed(2).padStart(6),
    (Number.isFinite(wr) ? wr.toFixed(0) + '%' : '—').padStart(6),
    f(mean(losers)),          // 平均虧損幅度（超額<0 者）
    f(pct(exu, 5)), f(pct(exu, 1)), f(exu.reduce((a, b) => Math.min(a, b), Infinity)),
    f(mean(raw)), f(mean(raw.filter(x => x < 0))), f(pct(raw, 5)),
    f(mean(mae)), f(pct(mae, 5)),
  ].join(' ');
}

const HEAD =
  '組別               n   超額均    t    勝率   平均賠   超額P5   超額P1  超額最差   絕對均  絕對賠均  絕對P5   MAE均   MAE_P5';

function section(title: string, groups: [string, Obs[]][], mid: string): void {
  console.log(`\n\n══════ ${title} ══════`);
  for (const h of HZ) {
    console.log(`\n── D${h} ──`);
    for (const seg of ['train', 'test', '全期'] as const) {
      console.log(`\n  [${seg}]`);
      console.log('  ' + HEAD);
      for (const [name, all] of groups) {
        const rows = seg === 'train' ? all.filter(o => o.date < mid)
          : seg === 'test' ? all.filter(o => o.date >= mid) : all;
        if (!rows.length) { console.log(`  ${name.padEnd(14)}  (無樣本)`); continue; }
        console.log('  ' + row(name, rows, h) + (rows.length < 100 ? '  ⚠樣本不足' : ''));
      }
    }
  }
}

function main() {
  const bench = loadBench();
  const stocks = loadStocks();
  const all: Obs[] = [];
  let done = 0;

  for (const s of stocks) {
    const cs = s.candles;
    for (let t = 60; t + 20 < cs.length; t++) {
      const c = cs[t];
      if (c.date < FROM || !liquid(c)) continue;
      const ex: Record<number, number> = {}, raw: Record<number, number> = {}, mae: Record<number, number> = {};
      let ok = true;
      for (const h of HZ) {
        const b = benchFwd(bench, c.date, h);
        if (b == null) { ok = false; break; }
        raw[h] = (cs[t + h].close / c.close - 1) * 100;
        ex[h] = raw[h] - b;
        let lo = Infinity;
        for (let k = t + 1; k <= t + h; k++) lo = Math.min(lo, cs[k].low);
        mae[h] = (lo / c.close - 1) * 100;
      }
      if (!ok) continue;
      const div = divergenceOnly(cs, t);
      // lowerHighs 較貴：只有在需要分組時才算 → 但 LH-only 組需要全體，故對液態日一律算
      const lh = lowerHighs(cs, t);
      all.push({
        date: c.date, symbol: s.symbol,
        hold: c.ma20 != null && c.ma20 > 0 && c.close > c.ma20,
        ex, exu: {}, raw, mae, lh, div,
        sellLL: (lh || div) ? sellLowerLowEvent(cs, t) : false,
        bear: (lh || div) ? detectTrend(cs, t) === '空頭' : false,
      });
    }
    if (++done % 200 === 0) process.stdout.write('.');
  }
  console.log('');

  attachExu(all);
  const dates = all.map(o => o.date).sort();
  const mid = dates[Math.floor(dates.length / 2)];

  const both = all.filter(o => o.lh && o.div);      // = 生產 R7
  const lhOnly = all.filter(o => o.lh && !o.div);
  const divOnly = all.filter(o => !o.lh && o.div);

  console.log(`\n宇宙 ${all.length} 股票日｜train/test 分界 ${mid}`);
  console.log(`R7(BOTH) ${both.length}｜只有頭頭低 ${lhOnly.length}｜只有背離 ${divOnly.length}`);
  console.log('\n判讀：出場有價值 ⇔ 訊號日之後的超額明顯為負、且「平均賠/P5/P1/MAE」明顯比宇宙差，');
  console.log('      且 train/test 同方向。若持平或為正 → 出場沒用（賣了少賺）。');

  section('A. 全體液態股票日', [
    ['宇宙baseline', all],
    ['R7 (兩者都要)', both],
    ['只有頭頭低', lhOnly],
    ['只有背離', divOnly],
  ], mid);

  // 中位數補充（超額分佈偏態時看）— 必須在 attachExu(hold) 重寫 exu 之前算
  const medLines: string[] = [];
  for (const [name, rows] of [['宇宙', all], ['R7', both], ['LH-only', lhOnly], ['DIV-only', divOnly]] as [string, Obs[]][]) {
    medLines.push(`    ${name.padEnd(10)} ${f(median(rows.map(o => o.exu[20]).filter(Number.isFinite)))}`);
  }

  // 持倉代理：收盤在 MA20 之上 —— 「已經持有且還沒破月線」的情境
  const hold = all.filter(o => o.hold);
  attachExu(hold); // 基準改成「同日、同樣還在 MA20 上的宇宙平均」
  const hBoth = hold.filter(o => o.lh && o.div);
  const hLh = hold.filter(o => o.lh && !o.div);
  const hDiv = hold.filter(o => !o.lh && o.div);
  section('B. 持倉代理（收盤 > MA20）', [
    ['宇宙baseline', hold],
    ['R7 (兩者都要)', hBoth],
    ['只有頭頭低', hLh],
    ['只有背離', hDiv],
  ], mid);

  // ── 重疊率 ───────────────────────────────────────────────────────────
  const ov = (rows: Obs[], k: 'sellLL' | 'bear') =>
    rows.length ? ((rows.filter(o => o[k]).length / rows.length) * 100).toFixed(1) + '%' : '—';
  console.log('\n\n══════ C. 與現有出場規則重疊率（同一天同時觸發）══════');
  console.log('  組別            n      sellSignals LOWER_LOW   trend=空頭   任一');
  for (const [name, rows] of [['R7(BOTH)', both], ['只有頭頭低', lhOnly], ['只有背離', divOnly]] as [string, Obs[]][]) {
    const either = rows.length
      ? ((rows.filter(o => o.sellLL || o.bear).length / rows.length) * 100).toFixed(1) + '%' : '—';
    console.log(`  ${name.padEnd(14)} ${String(rows.length).padStart(6)}   ${ov(rows, 'sellLL').padStart(10)}          ${ov(rows, 'bear').padStart(8)}   ${either.padStart(8)}`);
  }

  // 中位數補充（超額分佈偏態時看）
  console.log('\n  中位數超額（D20，基準=同日宇宙平均，全體母體）：');
  medLines.forEach(l => console.log(l));
}
main();
