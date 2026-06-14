/**
 * 陸股 v0 選股「有沒有正報酬」研究 — 找會漲的切法（防過度配適：train/test 分半，只信兩半同號）。
 *
 * 資料：hard_score_v0、tier≠C 的事件 + 即時報酬（隔日開盤進場、超額 vs 上證）。
 * 切分：依日期排序，舊 60% = train，新 40% = test。報酬看 raw + 超額（超額才是真本事）。
 * 測：①分數五分位（低分 vs 高分） ②抱多久（d1~d60） ③模式 ④每天「分數最低5 vs 最高5」。
 *
 * 用法：npx tsx scripts/research-cn-selection.ts
 */
import { loadEventsWithReturns } from '@/lib/cn-agents/backtest/recoPipeline';
import type { CnRecoEventWithReturns } from '@/lib/cn-agents/backtest/recoPipeline';
import type { RecoHorizon } from '@/lib/backtest/eventReturns';

const H: RecoHorizon[] = ['d1', 'd5', 'd10', 'd20', 'd60'];
const pct = (v: number | null) => (v == null ? '  —  ' : `${v >= 0 ? '+' : ''}${v.toFixed(2)}%`);

interface Cell { raw: number | null; exc: number | null; n: number }
function mean(events: CnRecoEventWithReturns[], h: RecoHorizon): Cell {
  let rs = 0, rn = 0, es = 0, en = 0;
  for (const e of events) {
    const r = e.returns; if (!r) continue;
    if (r[h] != null) { rs += r[h]!; rn++; }
    if (r.excess?.[h] != null) { es += r.excess[h]!; en++; }
  }
  return { raw: rn ? rs / rn : null, exc: en ? es / en : null, n: rn };
}

/** 印一個切法在 train/test 的 d5 raw+超額，標 ✓ 若兩半同號（穩定） */
function row(label: string, train: CnRecoEventWithReturns[], test: CnRecoEventWithReturns[], h: RecoHorizon = 'd5') {
  const tr = mean(train, h), te = mean(test, h);
  const stable = tr.exc != null && te.exc != null && Math.sign(tr.exc) === Math.sign(te.exc);
  const flag = tr.exc == null || te.exc == null ? '·' : stable ? (tr.exc > 0 ? '✓正' : '✓負') : '✗翻號';
  console.log(`${label.padEnd(20)} train 超額${pct(tr.exc)}(n${tr.n})  test 超額${pct(te.exc)}(n${te.n})  ${flag}`);
}

async function main() {
  const events = (await loadEventsWithReturns(440))
    .filter((e) => e.agentSource === 'hard_score_v0' && e.tier !== 'C' && e.returns);

  const dates = [...new Set(events.map((e) => e.date))].sort();
  const cut = dates[Math.floor(dates.length * 0.6)];
  const isTrain = (e: CnRecoEventWithReturns) => e.date < cut;
  const TR = events.filter(isTrain), TE = events.filter((e) => !isTrain(e));
  console.log(`事件 ${events.length} 筆、${dates.length} 天；train<${cut}(${TR.length}) / test≥${cut}(${TE.length})\n`);

  // 每日分數五分位
  const byDate = new Map<string, CnRecoEventWithReturns[]>();
  for (const e of events) { (byDate.get(e.date) ?? byDate.set(e.date, []).get(e.date)!).push(e); }
  const quint = new Map<CnRecoEventWithReturns, number>();
  for (const arr of byDate.values()) {
    const s = [...arr].sort((a, b) => a.totalScore - b.totalScore);
    s.forEach((e, i) => quint.set(e, Math.min(4, Math.floor((i / s.length) * 5))));
  }
  console.log('① 每日分數五分位（Q0最低分 … Q4最高分）— 看「低分是否比高分好」（d5 超額）');
  for (let q = 0; q < 5; q++) {
    const f = (e: CnRecoEventWithReturns) => quint.get(e) === q;
    row(`  Q${q}${q === 0 ? '(最低分)' : q === 4 ? '(最高分)' : ''}`, TR.filter(f), TE.filter(f));
  }

  console.log('\n② 全部候選 — 抱多久才對（raw / 超額，全期）');
  for (const h of H) {
    const c = mean(events, h);
    console.log(`  ${h.padEnd(4)} raw ${pct(c.raw)}   超額 ${pct(c.exc)}   (n${c.n})`);
  }

  console.log('\n③ 各模式（d5 超額，train/test）');
  for (const m of ['daban', 'banlu', 'dixi', 'swing', 'watch']) {
    const f = (e: CnRecoEventWithReturns) => e.mode === m;
    row(`  ${m}`, TR.filter(f), TE.filter(f));
  }

  console.log('\n④ 每天「分數最低5」vs「分數最高5」（d5 + d20 超額）');
  const lowPick: CnRecoEventWithReturns[] = [], highPick: CnRecoEventWithReturns[] = [];
  for (const arr of byDate.values()) {
    const s = [...arr].sort((a, b) => a.totalScore - b.totalScore);
    lowPick.push(...s.slice(0, 5));
    highPick.push(...s.slice(-5));
  }
  const lowTR = lowPick.filter(isTrain), lowTE = lowPick.filter((e) => !isTrain(e));
  const hiTR = highPick.filter(isTrain), hiTE = highPick.filter((e) => !isTrain(e));
  row('  最低5分 d5', lowTR, lowTE, 'd5'); row('  最低5分 d20', lowTR, lowTE, 'd20');
  row('  最高5分 d5', hiTR, hiTE, 'd5'); row('  最高5分 d20', hiTR, hiTE, 'd20');

  // ⑤ 穩健度：平均會被少數暴衝拉高 → 看中位數 + 勝率（避免被 outlier 騙）
  console.log('\n⑤ 「最低5分」穩健度 — 平均 vs 中位數 vs 勝率（d20，raw 與 超額）');
  const robust = (events: CnRecoEventWithReturns[], h: RecoHorizon) => {
    const raw = events.map((e) => e.returns?.[h]).filter((v): v is number => v != null);
    const exc = events.map((e) => e.returns?.excess?.[h]).filter((v): v is number => v != null);
    const med = (a: number[]) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
    const win = (a: number[]) => (a.length ? (a.filter((v) => v > 0).length / a.length * 100).toFixed(0) + '%' : '—');
    return { rawAvg: raw.length ? raw.reduce((s, v) => s + v, 0) / raw.length : null, rawMed: med(raw), rawWin: win(raw),
             excAvg: exc.length ? exc.reduce((s, v) => s + v, 0) / exc.length : null, excMed: med(exc), excWin: win(exc), n: raw.length };
  };
  for (const [lab, set] of [['train', lowTR], ['test', lowTE]] as const) {
    const r = robust(set, 'd20');
    console.log(`  ${lab}: raw 均${pct(r.rawAvg)} 中位${pct(r.rawMed)} 勝率${r.rawWin} | 超額 均${pct(r.excAvg)} 中位${pct(r.excMed)} 勝率${r.excWin} (n${r.n})`);
  }
  console.log('  對照 最高5分：');
  for (const [lab, set] of [['train', hiTR], ['test', hiTE]] as const) {
    const r = robust(set, 'd20');
    console.log(`  ${lab}: raw 均${pct(r.rawAvg)} 中位${pct(r.rawMed)} 勝率${r.rawWin} | 超額 均${pct(r.excAvg)} 中位${pct(r.excMed)} 勝率${r.excWin} (n${r.n})`);
  }

  // ⑥ 子分歸因：哪一條子分是反指標？各子分取「高三分位 vs 低三分位」的 d20 超額（pooled，train/test）
  console.log('\n⑥ 子分歸因（d20 超額；高三分位 vs 低三分位；gap=高−低，負=該子分越高越糟=反指標）');
  const keys = new Set<string>();
  for (const e of events) for (const k of Object.keys(e.scoreBreakdown ?? {})) keys.add(k);
  const med = (a: number[]) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
  const excMed = (set: CnRecoEventWithReturns[]) => med(set.map((e) => e.returns?.excess?.d20).filter((v): v is number => v != null));
  for (const k of [...keys].sort()) {
    const withK = events.filter((e) => (e.scoreBreakdown?.[k] ?? null) != null);
    if (withK.length < 200) { console.log(`  ${k.padEnd(16)} 樣本太少(${withK.length}) 跳過`); continue; }
    const vals = withK.map((e) => e.scoreBreakdown![k]!).sort((a, b) => a - b);
    const loCut = vals[Math.floor(vals.length / 3)], hiCut = vals[Math.floor(vals.length * 2 / 3)];
    const lo = (s: CnRecoEventWithReturns[]) => s.filter((e) => e.scoreBreakdown![k]! <= loCut);
    const hi = (s: CnRecoEventWithReturns[]) => s.filter((e) => e.scoreBreakdown![k]! >= hiCut);
    const g = (tr: CnRecoEventWithReturns[]) => { const h = excMed(hi(tr)), l = excMed(lo(tr)); return { h, l, gap: h != null && l != null ? h - l : null }; };
    const gt = g(withK.filter(isTrain)), ge = g(withK.filter((e) => !isTrain(e)));
    const stable = gt.gap != null && ge.gap != null && Math.sign(gt.gap) === Math.sign(ge.gap);
    console.log(`  ${k.padEnd(16)} train 高${pct(gt.h)}/低${pct(gt.l)} gap${pct(gt.gap)} | test 高${pct(ge.h)}/低${pct(ge.l)} gap${pct(ge.gap)} ${gt.gap == null || ge.gap == null ? '·' : stable ? (gt.gap < 0 ? '✓反指' : '✓正相關') : '✗翻號'}`);
  }
}
main();
