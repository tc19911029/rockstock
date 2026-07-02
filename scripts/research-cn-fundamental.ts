/**
 * 陸股基本面因子 橫斷面回測（嚴格版，吸收今晚教訓）。
 *
 * point-in-time：因子值 = 公告日(noticeDate)≤換倉日 T 的最近一季（不偷看未來財報）。
 * 月度換倉，每個 T 把全樣本按因子分 5 等分(Q1低…Q5高)，算各分位「對上證超額」的
 * 前瞻 d20/d60；**每個換倉日先算分位均值再跨日平均**（每日一觀測，無偽複製）。
 * train(舊60%)/test(新40%)。看 Q5−Q1 spread 是否穩定 + 單調 → 因子有沒有效。
 *
 * 因子：净利同比 / 营收同比 / ROE / 毛利率 / PB(價值,低好) / 20日動能(對照)
 * 用法：npx tsx scripts/research-cn-fundamental.ts
 */
import fs from 'fs';
import path from 'path';

const CDIR = path.join(process.cwd(), 'data', 'candles', 'CN');
const FDIR = path.join(process.cwd(), 'data', 'cn-agents', '_fin-cache');
const IDX = '000001.SS';

interface Q { reportDate: string; noticeDate: string | null; revenueYoY: number | null; netProfitYoY: number | null; roe: number | null; grossMargin: number | null; bps: number | null }
interface Stock { sym: string; quarters: Q[]; dates: string[]; close: number[]; at: Map<string, number> }

function loadCandles(sym: string): { dates: string[]; close: number[]; at: Map<string, number> } | null {
  try {
    const c = (JSON.parse(fs.readFileSync(path.join(CDIR, `${sym}.json`), 'utf8')).candles ?? []) as Array<{ date: string; close: number }>;
    if (c.length < 60) return null;
    return { dates: c.map((x) => x.date), close: c.map((x) => x.close), at: new Map(c.map((x, i) => [x.date, i])) };
  } catch { return null; }
}

// 載入樣本（有財報快取 + 有 K 線）
const stocks: Stock[] = [];
for (const f of fs.existsSync(FDIR) ? fs.readdirSync(FDIR).filter((x) => x.endsWith('.json')) : []) {
  const sym = f.replace('.json', '');
  let quarters: Q[];
  try { quarters = (JSON.parse(fs.readFileSync(path.join(FDIR, f), 'utf8')).quarters ?? []) as Q[]; } catch { continue; }
  quarters = quarters.filter((q) => q.noticeDate).sort((a, b) => (a.noticeDate! < b.noticeDate! ? -1 : 1)); // PIT 要公告日
  if (quarters.length < 4) continue;
  const cand = loadCandles(sym);
  if (!cand) continue;
  stocks.push({ sym, quarters, ...cand });
}
const idxC = loadCandles(IDX)!;

// 月末換倉日（用指數交易日）
const monthEnd = new Map<string, string>();
for (const d of idxC.dates) monthEnd.set(d.slice(0, 7), d);
const rebal = [...monthEnd.values()].filter((d) => d >= '2022-01-01' && d <= '2026-03-31').sort();

const FACTORS = ['净利同比', '营收同比', 'ROE', '毛利率', 'PB低', '動能20'] as const;
type F = typeof FACTORS[number];
const fwdRet = (s: { dates: string[]; close: number[]; at: Map<string, number> }, date: string, n: number): number | null => {
  let i = s.at.get(date); if (i == null) { i = s.dates.findIndex((d) => d >= date); if (i < 0) return null; }
  const j = i + n; if (j >= s.close.length) return null; return (s.close[j] - s.close[i]) / s.close[i] * 100;
};
const priceAt = (s: Stock, date: string): number | null => { let i = s.at.get(date); if (i == null) { i = s.dates.findIndex((d) => d >= date); if (i < 0) return null; } return s.close[i]; };

// 每因子每分位：各換倉日的「分位平均超額」清單（train/test）
const acc: Record<F, { [q: number]: { tr: number[]; te: number[] } }> = {} as never;
for (const f of FACTORS) { acc[f] = {}; for (let q = 0; q < 5; q++) acc[f][q] = { tr: [], te: [] }; }
const cut = rebal[Math.floor(rebal.length * 0.6)];

for (const T of rebal) {
  for (const horizon of [20] as const) {
    const idxFwd = fwdRet(idxC, T, horizon);
    if (idxFwd == null) continue;
    // 收集每檔的因子值 + 超額
    const recs: Array<{ vals: Partial<Record<F, number>>; exc: number }> = [];
    for (const s of stocks) {
      const q = [...s.quarters].reverse().find((x) => x.noticeDate! <= T); // 最近已公告季
      if (!q) continue;
      const px = priceAt(s, T); const fwd = fwdRet(s, T, horizon);
      if (px == null || fwd == null) continue;
      const vals: Partial<Record<F, number>> = {};
      if (q.netProfitYoY != null) vals['净利同比'] = q.netProfitYoY;
      if (q.revenueYoY != null) vals['营收同比'] = q.revenueYoY;
      if (q.roe != null) vals['ROE'] = q.roe;
      if (q.grossMargin != null) vals['毛利率'] = q.grossMargin;
      if (q.bps != null && q.bps > 0) vals['PB低'] = -(px / q.bps); // 取負 → Q5=PB最低(最便宜)
      const mom = fwdRet(s, T, -20); // 過去20日(用負offset取不到→自算)
      const i = s.at.get(T) ?? s.dates.findIndex((d) => d >= T);
      if (i != null && i >= 20) vals['動能20'] = (s.close[i] - s.close[i - 20]) / s.close[i - 20] * 100;
      recs.push({ vals, exc: fwd - idxFwd });
    }
    // 每因子分位
    for (const f of FACTORS) {
      const withF = recs.filter((r) => r.vals[f] != null).sort((a, b) => a.vals[f]! - b.vals[f]!);
      if (withF.length < 25) continue;
      const per = Math.floor(withF.length / 5);
      for (let qi = 0; qi < 5; qi++) {
        const slice = withF.slice(qi * per, qi === 4 ? withF.length : (qi + 1) * per);
        const m = slice.reduce((x, r) => x + r.exc, 0) / slice.length;
        (T >= cut ? acc[f][qi].te : acc[f][qi].tr).push(m);
      }
    }
  }
}

const avg = (a: number[]) => (a.length ? a.reduce((x, v) => x + v, 0) / a.length : null);
const pct = (v: number | null) => (v == null ? ' — ' : `${v >= 0 ? '+' : ''}${v.toFixed(2)}%`);
console.log(`樣本 ${stocks.length} 檔、換倉 ${rebal.length} 次（${rebal[0]}~${rebal[rebal.length - 1]}）、cut=${cut}。d20 超額 vs 上證，每換倉日聚合\n`);
for (const f of FACTORS) {
  const q = (qi: number, te: boolean) => avg(te ? acc[f][qi].te : acc[f][qi].tr);
  const spr = (te: boolean) => { const a = q(4, te), b = q(0, te); return a != null && b != null ? a - b : null; };
  console.log(`【${f}】(Q5=因子最高${f === 'PB低' ? '即PB最低/最便宜' : ''})`);
  console.log(`  train Q1${pct(q(0, false))} Q3${pct(q(2, false))} Q5${pct(q(4, false))}  Q5−Q1=${pct(spr(false))}`);
  console.log(`  test  Q1${pct(q(0, true))} Q3${pct(q(2, true))} Q5${pct(q(4, true))}  Q5−Q1=${pct(spr(true))}`);
}
