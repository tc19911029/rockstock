/**
 * 「漲停結構子分要怎麼改」變體回測 — 改 code 前先證明哪種改法 out-of-sample 真的變好。
 *
 * 用事件已凍結的 scoreBreakdown 重算 totalScore 變體（不動 production）：
 *   cur=現況 / revLS=漲停結構反向(100−v) / noLS=移除漲停結構 / lowCur=反過來挑最低分。
 * 每天用各變體分數排序取前 5，看 d5/d20 超額（均+中位+勝率），train(舊60%)/test(新40%)。
 *
 * 用法：npx tsx scripts/research-cn-ls-fix.ts
 */
import { loadEventsWithReturns } from '@/lib/cn-agents/backtest/recoPipeline';
import type { CnRecoEventWithReturns } from '@/lib/cn-agents/backtest/recoPipeline';
import { computeCnTotalScore, type CnSubScores } from '@/lib/cn-agents/scoring';
import type { RecoHorizon } from '@/lib/backtest/eventReturns';

const pct = (v: number | null) => (v == null ? '  —  ' : `${v >= 0 ? '+' : ''}${v.toFixed(2)}%`);
const med = (a: number[]) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
const avg = (a: number[]) => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : null);
const win = (a: number[]) => (a.length ? +(a.filter((v) => v > 0).length / a.length * 100).toFixed(0) : null);

function score(sb: CnSubScores): number { return computeCnTotalScore(sb).totalScore; }

const VARIANTS: Record<string, { key: (sb: CnSubScores) => number; dir: 1 | -1 }> = {
  '現況(高分在前)': { key: (sb) => score(sb), dir: -1 },
  '反過來(低分在前)': { key: (sb) => score(sb), dir: 1 },
  '漲停結構反向': { key: (sb) => score({ ...sb, limitStructure: sb.limitStructure != null ? 100 - sb.limitStructure : sb.limitStructure }), dir: -1 },
  '移除漲停結構': { key: (sb) => score({ ...sb, limitStructure: null }), dir: -1 },
};

function stat(picks: CnRecoEventWithReturns[], h: RecoHorizon) {
  const exc = picks.map((e) => e.returns?.excess?.[h]).filter((v): v is number => v != null);
  return `均${pct(avg(exc))} 中位${pct(med(exc))} 勝率${win(exc) ?? '—'}%`;
}

async function main() {
  const events = (await loadEventsWithReturns(440))
    .filter((e) => e.agentSource === 'hard_score_v0' && e.tier !== 'C' && e.returns);
  const dates = [...new Set(events.map((e) => e.date))].sort();
  const cut = dates[Math.floor(dates.length * 0.6)];

  // sanity：重算現況分 vs 凍結 totalScore 是否一致
  let diff = 0, dn = 0;
  for (const e of events) { const r = score((e.scoreBreakdown ?? {}) as CnSubScores); diff += Math.abs(r - e.totalScore); dn++; }
  console.log(`重算 vs 凍結 totalScore 平均差 ${(diff / dn).toFixed(2)} 分（應≈0 才表示 scoreBreakdown 完整）\n`);

  const byDate = new Map<string, CnRecoEventWithReturns[]>();
  for (const e of events) { (byDate.get(e.date) ?? byDate.set(e.date, []).get(e.date)!).push(e); }

  const K = 5;
  for (const [name, v] of Object.entries(VARIANTS)) {
    const tr: CnRecoEventWithReturns[] = [], te: CnRecoEventWithReturns[] = [];
    for (const [d, arr] of byDate) {
      const top = [...arr].sort((a, b) => v.dir * (v.key((a.scoreBreakdown ?? {}) as CnSubScores) - v.key((b.scoreBreakdown ?? {}) as CnSubScores))).slice(0, K);
      (d < cut ? tr : te).push(...top);
    }
    console.log(`${name.padEnd(18)}`);
    console.log(`  d5  train ${stat(tr, 'd5')}   test ${stat(te, 'd5')}`);
    console.log(`  d20 train ${stat(tr, 'd20')}   test ${stat(te, 'd20')}\n`);
  }
}
main();
