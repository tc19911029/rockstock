/**
 * 回測陸股龍虎榜有沒有 edge — 同 股东户数 的誠實做法（去 beta + train/test）。
 *
 * 資料：data/cn-agents/lhb/{date}.json（244 天、~2 萬筆上榜個股；含 netAmt 淨買超、
 *   changeRate 當日漲跌、seatSummary 席位 机构/游资/拉萨散戶/北向）。
 * 進場：上榜日次一交易日開盤（settleBaseline）；報酬對上證 000001.SS 超額（computeEventReturns）。
 * 誠實化：同月去平均的橫斷面 alpha（洗掉 universe beta + 上榜擠堆共同因子）。
 *
 * 測三刀：
 *   A. 淨買超/流通市值 五等分（主力買越多事後越好？）
 *   B. 席位類型（機構買 / 游資買 / 拉薩散戶買 / 北向買 各 vs 同月同類）
 *   C. 漲多上榜 vs 跌多上榜
 *
 * 用法：npx tsx scripts/backtest-cn-lhb-edge.ts
 */
import { promises as fs } from 'fs';
import path from 'path';
import { classifyCnBoard } from '@/lib/cn-agents/cnBoard';
import { loadCandlesForEvent, loadShIndexCandles } from '@/lib/cn-agents/backtest/recoPipeline';
import { settleBaseline, type BaselineCandle } from '@/lib/backtest/eventBaseline';
import { computeEventReturns } from '@/lib/backtest/eventReturns';
import type { CnBoardKind } from '@/lib/cn-agents/types';

const LHB_DIR = path.join(process.cwd(), 'data', 'cn-agents', 'lhb');
const COST = 0.112;
type H = 'd5' | 'd10' | 'd20';
const HS: H[] = ['d5', 'd10', 'd20'];

interface SeatSummary {
  institutionBuyCount: number; institutionSellCount: number;
  hotMoneyBuyCount: number; retailProxyBuyCount: number;
  quantBuyCount: number; northboundBuyCount: number;
}
interface LhbStock {
  code: string; name: string; board: CnBoardKind; changeRate: number;
  netAmt: number; freeMarketCap: number; seatSummary: SeatSummary;
}
interface LhbFile { date: string; stocks: LhbStock[]; }

interface Ev {
  date: string;          // 進場交易日
  netRatio: number;      // 淨買超 / 流通市值
  changeRate: number;    // 上榜日漲跌
  seat: SeatSummary;
  ex: Record<H, number | null>;   // 對指數超額（raw level）
  al: Record<H, number | null>;   // 同月去平均 alpha（誠實）
}

const suffixFor = (b: CnBoardKind) => (b === 'SH-main' || b === 'STAR' ? 'SS' : b === 'BJ' ? 'BJ' : 'SZ');
const avg = (xs: number[]): number | null => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
const winPct = (xs: number[]): number | null => (xs.length ? (100 * xs.filter((x) => x > 0).length) / xs.length : null);
const f2 = (x: number | null): string => (x == null ? '  —  ' : (x >= 0 ? '+' : '') + x.toFixed(2));
const monthKey = (d: string) => d.slice(0, 7);

/** 一組事件在某 horizon 的誠實 alpha + train/test（依進場日中點切）。 */
function group(evs: Ev[], h: H, mid: string) {
  const all = evs.map((e) => e.al[h]).filter((x): x is number => x != null);
  const tr = evs.filter((e) => e.date < mid).map((e) => e.al[h]).filter((x): x is number => x != null);
  const te = evs.filter((e) => e.date >= mid).map((e) => e.al[h]).filter((x): x is number => x != null);
  const m = avg(all);
  const exLevel = avg(evs.map((e) => e.ex[h]).filter((x): x is number => x != null));
  return {
    n: all.length, alpha: m, net: m == null ? null : +(m - COST).toFixed(2), win: winPct(all),
    exLevel, exTrain: avg(tr), exTest: avg(te),
    consistent: (() => { const a = avg(tr), b = avg(te); return a != null && b != null && ((a > 0 && b > 0) || (a < 0 && b < 0)); })(),
  };
}
function tag(g: ReturnType<typeof group>): string {
  if (g.exTrain == null || g.exTest == null) return '樣本不足';
  return g.consistent ? (g.exTest > 0 ? '✓同正' : '✓同負') : '✗反向';
}

async function main() {
  const files = (await fs.readdir(LHB_DIR)).filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort();
  console.log(`讀 ${files.length} 天龍虎榜…`);
  const index = await loadShIndexCandles();
  if (!index) { console.error('缺上證指數'); process.exit(1); }
  const now = new Date().toISOString();
  const todayYmd8 = now.slice(0, 10).replaceAll('-', '');
  const candleMemo = new Map<string, BaselineCandle[] | null>();

  const raw: Ev[] = [];
  let attempts = 0, filled = 0, noFill = 0, noData = 0;

  for (const f of files) {
    let file: LhbFile;
    try { file = JSON.parse(await fs.readFile(path.join(LHB_DIR, f), 'utf-8')); } catch { continue; }
    for (const s of file.stocks || []) {
      if (!s.freeMarketCap || s.freeMarketCap <= 0) continue;
      attempts++;
      const symbol = `${s.code}.${suffixFor(s.board)}`;
      let candles = candleMemo.get(symbol);
      if (candles === undefined) { candles = await loadCandlesForEvent(symbol, s.board, todayYmd8); candleMemo.set(symbol, candles); }
      const baseline = settleBaseline(file.date, candles, now);
      if (baseline.status === 'no_fill') { noFill++; continue; }
      if (baseline.status !== 'filled') { noData++; continue; }
      filled++;
      const r = computeEventReturns({ baseline }, candles, index);
      if (!r) continue;
      raw.push({
        date: baseline.base_date as string,
        netRatio: s.netAmt / s.freeMarketCap * 100,
        changeRate: s.changeRate,
        seat: s.seatSummary,
        ex: { d5: r.excess.d5, d10: r.excess.d10, d20: r.excess.d20 },
        al: { d5: null, d10: null, d20: null },
      });
    }
  }

  // 同月去平均 → 填 al（誠實 alpha）
  for (const h of HS) {
    const acc = new Map<string, { s: number; n: number }>();
    for (const e of raw) { const v = e.ex[h]; if (v == null) continue; const k = monthKey(e.date); const o = acc.get(k) ?? { s: 0, n: 0 }; o.s += v; o.n++; acc.set(k, o); }
    const mean = new Map<string, number>(); for (const [k, o] of acc) mean.set(k, o.s / o.n);
    for (const e of raw) { const v = e.ex[h]; e.al[h] = v == null ? null : +(v - (mean.get(monthKey(e.date)) as number)).toFixed(2); }
  }

  const dated = [...raw].sort((a, b) => (a.date < b.date ? -1 : 1));
  const mid = dated[Math.floor(dated.length / 2)].date;
  console.log(`進場成功 ${filled}（一字板買不到 ${noFill}、無資料 ${noData}）；可回測 ${raw.length} 筆，train/test 切點 ${mid}`);
  console.log('（誠實 alpha = 同月去平均；正＝比當月同樣上榜的股票好，已洗掉大盤 beta）');

  // 全體 lhb vs 指數（含 beta，僅看「上榜這群整體贏不贏大盤」）
  console.log('\n【全體龍虎榜 vs 上證（含 beta）】');
  for (const h of HS) { const g = group(raw, h, mid); console.log(`  ${h}: 對指數 ${f2(g.exLevel)}%（n=${g.n}）`); }

  // ── A. 淨買超/流通市值 五等分 ──
  console.log('\n【A. 淨買超/流通市值 五等分 — 誠實 alpha（d10 為主）】');
  const byRatio = [...raw].sort((a, b) => a.netRatio - b.netRatio);
  const N = byRatio.length;
  const labelsA = ['Q0 淨賣最多', 'Q1', 'Q2', 'Q3', 'Q4 淨買最多'];
  for (let b = 0; b < 5; b++) {
    const slice = byRatio.slice(Math.floor((b * N) / 5), Math.floor(((b + 1) * N) / 5));
    const g = group(slice, 'd10', mid);
    console.log(`  ${labelsA[b].padEnd(12)} netRatio[${slice[0].netRatio.toFixed(2)},${slice[slice.length - 1].netRatio.toFixed(2)}]  alpha ${f2(g.alpha)}%/勝${g.win == null ? '—' : g.win.toFixed(0)}%  train→test ${f2(g.exTrain)}→${f2(g.exTest)} ${tag(g)}`);
  }

  // ── B. 席位類型 ──
  console.log('\n【B. 誰在買 — 誠實 alpha（d10）】');
  const seatGroups: Array<[string, (e: Ev) => boolean]> = [
    ['機構淨買', (e) => e.seat.institutionBuyCount > e.seat.institutionSellCount],
    ['游資買', (e) => e.seat.hotMoneyBuyCount > 0],
    ['拉薩散戶買', (e) => e.seat.retailProxyBuyCount > 0],
    ['北向買', (e) => e.seat.northboundBuyCount > 0],
    ['量化買', (e) => e.seat.quantBuyCount > 0],
  ];
  for (const [label, pred] of seatGroups) {
    const g = group(raw.filter(pred), 'd10', mid);
    console.log(`  ${label.padEnd(12)} n=${String(g.n).padStart(5)}  alpha ${f2(g.alpha)}%/勝${g.win == null ? '—' : g.win.toFixed(0)}%  train→test ${f2(g.exTrain)}→${f2(g.exTest)} ${tag(g)}`);
  }

  // ── C. 漲多 vs 跌多上榜 ──
  console.log('\n【C. 漲多 vs 跌多上榜 — 誠實 alpha（d10）】');
  const cGroups: Array<[string, (e: Ev) => boolean]> = [
    ['跌多(<-3%)', (e) => e.changeRate < -3],
    ['小跌(-3~0)', (e) => e.changeRate >= -3 && e.changeRate < 0],
    ['小漲(0~5%)', (e) => e.changeRate >= 0 && e.changeRate < 5],
    ['漲多(>5%)', (e) => e.changeRate >= 5],
  ];
  for (const [label, pred] of cGroups) {
    const g = group(raw.filter(pred), 'd10', mid);
    console.log(`  ${label.padEnd(12)} n=${String(g.n).padStart(5)}  alpha ${f2(g.alpha)}%/勝${g.win == null ? '—' : g.win.toFixed(0)}%  train→test ${f2(g.exTrain)}→${f2(g.exTest)} ${tag(g)}`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
