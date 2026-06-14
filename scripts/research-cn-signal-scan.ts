/**
 * 每個現有子分訊號「到底有沒有預測力」總掃 — 對齊規格 18-agent，看哪幾步真的有用。
 *
 * 對 events 裡實際存到的每個 scoreBreakdown 子分：高三分位 vs 低三分位的「事後超額中位數」
 * （d5/d20/d60，train 舊60% / test 新40%）。gap=高−低：負=越高越糟(反指)、正=越高越好(順指)、
 * train/test 同號才算數。順便列各子分覆蓋率（多少事件有值）= 規格哪些 agent 其實沒資料。
 *
 * 用法：npx tsx scripts/research-cn-signal-scan.ts
 */
import { loadEventsWithReturns } from '@/lib/cn-agents/backtest/recoPipeline';
import type { CnRecoEventWithReturns } from '@/lib/cn-agents/backtest/recoPipeline';
import type { RecoHorizon } from '@/lib/backtest/eventReturns';

const pct = (v: number | null) => (v == null ? ' — ' : `${v >= 0 ? '+' : ''}${v.toFixed(1)}%`);
const med = (a: number[]) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
const HZ: RecoHorizon[] = ['d5', 'd20', 'd60'];

function excMed(set: CnRecoEventWithReturns[], h: RecoHorizon) {
  return med(set.map((e) => e.returns?.excess?.[h]).filter((v): v is number => v != null));
}

async function main() {
  const events = (await loadEventsWithReturns(440))
    .filter((e) => e.agentSource === 'hard_score_v0' && e.tier !== 'C' && e.returns);
  const dates = [...new Set(events.map((e) => e.date))].sort();
  const cut = dates[Math.floor(dates.length * 0.6)];
  const isTr = (e: CnRecoEventWithReturns) => e.date < cut;

  const keys = new Set<string>();
  for (const e of events) for (const k of Object.keys(e.scoreBreakdown ?? {})) keys.add(k);

  console.log(`事件 ${events.length} 筆、${dates.length} 天；train<${cut} / test≥${cut}`);
  console.log('（覆蓋率 = 多少事件這個子分有值。gap=高三分位−低三分位的事後超額中位；負=反指、正=順指）\n');

  for (const k of [...keys].sort()) {
    const withK = events.filter((e) => (e.scoreBreakdown?.[k] ?? null) != null);
    const cover = ((withK.length / events.length) * 100).toFixed(0);
    if (withK.length < 200) { console.log(`【${k}】覆蓋率 ${cover}%（${withK.length}）— 樣本太少，跳過`); continue; }
    const vals = withK.map((e) => e.scoreBreakdown![k]!).sort((a, b) => a - b);
    const loCut = vals[Math.floor(vals.length / 3)], hiCut = vals[Math.floor(vals.length * 2 / 3)];
    const uniq = new Set(vals).size;
    const lo = (s: CnRecoEventWithReturns[]) => s.filter((e) => e.scoreBreakdown![k]! <= loCut);
    const hi = (s: CnRecoEventWithReturns[]) => s.filter((e) => e.scoreBreakdown![k]! >= hiCut);
    console.log(`【${k}】覆蓋率 ${cover}%、相異值 ${uniq}`);
    for (const h of HZ) {
      const trH = hi(withK.filter(isTr)), trL = lo(withK.filter(isTr));
      const teH = hi(withK.filter((e) => !isTr(e))), teL = lo(withK.filter((e) => !isTr(e)));
      const gTr = excMed(trH, h), lTr = excMed(trL, h), gTe = excMed(teH, h), lTe = excMed(teL, h);
      const gapTr = gTr != null && lTr != null ? gTr - lTr : null;
      const gapTe = gTe != null && lTe != null ? gTe - lTe : null;
      const flag = gapTr == null || gapTe == null ? '·' : Math.sign(gapTr) === Math.sign(gapTe) ? (gapTr < 0 ? '✓反指' : '✓順指') : '✗翻號';
      console.log(`   ${h.padEnd(4)} gap train ${pct(gapTr)} / test ${pct(gapTe)}  ${flag}`);
    }
  }
}
main();
