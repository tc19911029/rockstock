/**
 * 量「應買排序」實際選出來的股票事後漲多少（誠實檢驗 UI 預設排序的 alpha）。
 *
 * 每個事件日：取 hard_score_v0、tier≠C 的候選（= UI 那批）→ 用 buyRank（與 UI 同公式：
 * phaseModeEdge 打法優先 → 分層 → 分數）排序 → 取前 K 名 → 算事後 d1/d5/d10/d20 平均報酬
 * 與對上證超額。對照「全部候選平均」。報酬即時 derive（loadEventsWithReturns）。
 *
 * 用法：npx tsx scripts/report-cn-buysort.ts
 */
import { loadEventsWithReturns } from '@/lib/cn-agents/backtest/recoPipeline';
import { phaseModeEdge } from '@/lib/cn-agents/phaseModeEdge';
import type { CnRecoEventWithReturns } from '@/lib/cn-agents/backtest/recoPipeline';
import type { CnRecoMode, EmotionStage } from '@/lib/cn-agents/types';

const TIER_RANK: Record<string, number> = { A: 0, B: 1, C: 2 };
function buyRank(e: CnRecoEventWithReturns): number {
  const tierRank = TIER_RANK[e.tier] ?? 9;
  const edge = phaseModeEdge(e.mode as CnRecoMode, e.sentimentPhase as EmotionStage);
  return edge * 100000 + (2 - tierRank) * 1000 + e.totalScore;
}

const H = ['d1', 'd5', 'd10', 'd20'] as const;

function agg(picks: CnRecoEventWithReturns[]) {
  const ret: Record<string, { s: number; n: number }> = {};
  const exc: Record<string, { s: number; n: number }> = {};
  for (const h of H) { ret[h] = { s: 0, n: 0 }; exc[h] = { s: 0, n: 0 }; }
  let success = 0, scored = 0;
  for (const e of picks) {
    const r = e.returns;
    if (!r) continue;
    for (const h of H) {
      if (r[h] != null) { ret[h].s += r[h]!; ret[h].n++; }
      if (r.excess?.[h] != null) { exc[h].s += r.excess[h]!; exc[h].n++; }
    }
    if (r.d5 != null) { scored++; if (r.d5 > 3) success++; }
  }
  const avg = (m: Record<string, { s: number; n: number }>) =>
    H.map((h) => `${h} ${m[h].n ? (m[h].s / m[h].n >= 0 ? '+' : '') + (m[h].s / m[h].n).toFixed(2) + '%' : '—'}`).join('  ');
  return { line: avg(ret), exc: avg(exc), successRate: scored ? (success / scored * 100).toFixed(0) + '%' : '—', scored };
}

const ORDERINGS: Record<string, (e: CnRecoEventWithReturns) => number> = {
  分數: (e) => e.totalScore,
  分層優先: (e) => (2 - (TIER_RANK[e.tier] ?? 9)) * 1000 + e.totalScore,
  應買_打法優先: (e) => buyRank(e),
  低吸波段only: (e) => (e.mode === 'dixi' || e.mode === 'swing' ? 1 : 0) * 1e6 + e.totalScore,
};

async function main() {
  const events = (await loadEventsWithReturns(420))
    .filter((e) => e.agentSource === 'hard_score_v0' && e.tier !== 'C');

  const byDate = new Map<string, CnRecoEventWithReturns[]>();
  for (const e of events) {
    if (!byDate.has(e.date)) byDate.set(e.date, []);
    byDate.get(e.date)!.push(e);
  }
  console.log(`事件日 ${byDate.size} 天、候選共 ${events.length} 筆（hard_score_v0、tier≠C）\n`);

  const K = 5;
  for (const [name, keyFn] of Object.entries(ORDERINGS)) {
    const picks: CnRecoEventWithReturns[] = [];
    for (const arr of byDate.values()) {
      picks.push(...[...arr].sort((a, b) => keyFn(b) - keyFn(a)).slice(0, K));
    }
    const a = agg(picks);
    console.log(`${name.padEnd(14)} top${K}  報酬: ${a.line}`);
    console.log(`${' '.repeat(14)}        超額: ${a.exc}   成功率: ${a.successRate}\n`);
  }
  const all = agg(events);
  console.log(`全部候選(對照)     報酬: ${all.line}`);
  console.log(`${' '.repeat(14)}        超額: ${all.exc}   成功率: ${all.successRate}`);
}
main();
