/**
 * P5 校準的 out-of-sample lift 檢驗：套 phaseModeEdge 重排後，每日 top-N 的隔日超額有沒有變好？
 *
 * 對每個交易日，拿 hard_score_v0 候選：
 *   - baseline：按原始 totalScore 排序取 top-N
 *   - edged：按 totalScore + phaseModeEdge 重排取 top-N
 * 比較兩組 top-N 的 d5 超額(vs上證)均值。重點看 **test 半段（新40%）** — edge 表是
 * 在 train 段定的，test 段的改善才是 out-of-sample 證據。
 *
 * 用法：npx tsx scripts/research-cn-edge-liftcheck.ts [topN=5]
 */

import { config as loadEnv } from 'dotenv';
loadEnv({ path: '.env.local' });
loadEnv();

import { loadEventsWithReturns, type CnRecoEventWithReturns } from '@/lib/cn-agents/backtest/recoPipeline';
import { phaseModeEdge } from '@/lib/cn-agents/phaseModeEdge';

function meanExcess(events: CnRecoEventWithReturns[]): number | null {
  const v = events.map((e) => e.returns?.excess?.d5).filter((x): x is number => x != null && Number.isFinite(x));
  return v.length ? +(v.reduce((a, b) => a + b, 0) / v.length).toFixed(3) : null;
}

async function main(): Promise<void> {
  const topN = parseInt(process.argv[2] ?? '5', 10);
  const all = (await loadEventsWithReturns(500)).filter((e) => e.agentSource === 'hard_score_v0');
  const dates = [...new Set(all.map((e) => e.date))].sort();
  const splitDate = dates[Math.floor(dates.length * 0.6)];

  const baseTest: CnRecoEventWithReturns[] = [];
  const edgeTest: CnRecoEventWithReturns[] = [];
  const baseTrain: CnRecoEventWithReturns[] = [];
  const edgeTrain: CnRecoEventWithReturns[] = [];
  for (const d of dates) {
    const day = all.filter((e) => e.date === d && e.tier !== 'C');
    if (!day.length) continue;
    const base = [...day].sort((a, b) => b.totalScore - a.totalScore).slice(0, topN);
    const edged = [...day].sort((a, b) =>
      (b.totalScore + phaseModeEdge(b.mode, b.sentimentPhase)) - (a.totalScore + phaseModeEdge(a.mode, a.sentimentPhase)),
    ).slice(0, topN);
    if (d >= splitDate) { baseTest.push(...base); edgeTest.push(...edged); }
    else { baseTrain.push(...base); edgeTrain.push(...edged); }
  }

  console.log(`📊 每日 top-${topN}；split=${splitDate}（train < / test ≥）`);
  console.table([
    { 段: 'train', baseline超額d5: meanExcess(baseTrain), edged超額d5: meanExcess(edgeTrain), n: baseTrain.length },
    { 段: 'test(OOS)', baseline超額d5: meanExcess(baseTest), edged超額d5: meanExcess(edgeTest), n: baseTest.length },
    { 段: '全期', baseline超額d5: meanExcess([...baseTrain, ...baseTest]), edged超額d5: meanExcess([...edgeTrain, ...edgeTest]), n: baseTrain.length + baseTest.length },
  ]);
  const bt = meanExcess(baseTest), et = meanExcess(edgeTest);
  if (bt != null && et != null) {
    console.log(`\n${et > bt ? '✅' : '❌'} test(OOS) edge ${et > bt ? '拉高' : '沒拉高'} top-${topN} 超額：${bt} → ${et}（Δ ${(et - bt).toFixed(3)}）`);
  }
}

main().catch((err) => { console.error(err); process.exit(1); });
