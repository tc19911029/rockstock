/**
 * 模式×情緒階段交叉勝率表報告（P4）— 唯讀，回答「哪個打法在哪個情緒階段真有 edge」
 *
 * 用法：npx tsx scripts/report-cn-crosstable.ts [days=400]
 */

import { config as loadEnv } from 'dotenv';
loadEnv({ path: '.env.local' });
loadEnv();

import { loadEventsWithReturns } from '@/lib/cn-agents/backtest/recoPipeline';
import { buildModePhaseCrossTable, buildTierTable } from '@/lib/cn-agents/backtest/crossTable';
import { STAGE_LABELS, RECO_MODE_LABELS } from '@/lib/cn-agents/types';
import type { EmotionStage, CnRecoMode } from '@/lib/cn-agents/types';

async function main(): Promise<void> {
  const days = parseInt(process.argv[2] ?? '400', 10);
  const events = await loadEventsWithReturns(days);
  const hs = events.filter((e) => e.agentSource === 'hard_score_v0');
  console.log(`📊 hard_score_v0 事件 ${hs.length}（近 ${days} 日）`);

  const cross = buildModePhaseCrossTable(hs);
  const rows = cross.filter((c) => c.filled >= 5).sort((a, b) => (b.avg.d5 ?? -99) - (a.avg.d5 ?? -99));
  console.log('\n模式 × 情緒階段（filled≥5，按 d5 均報酬排序）：');
  console.table(rows.map((c) => ({
    模式: RECO_MODE_LABELS[c.mode as CnRecoMode] ?? c.mode,
    階段: STAGE_LABELS[c.phase as EmotionStage] ?? c.phase,
    n: c.filled, 買不到: c.unfillable,
    勝率d1: c.winRate.d1, 勝率d5: c.winRate.d5,
    均d1: c.avg.d1, 均d3: c.avg.d3, 均d5: c.avg.d5,
    超額d5: c.excessAvg,
  })));

  console.log('\n分層（tier）整體：');
  console.table(buildTierTable(hs).map((t) => ({ tier: t.tier, n: t.filled, 勝率d5: t.winRate.d5, 均d5: t.avg.d5, 超額d5: t.excessAvg })));
}

main().catch((err) => { console.error(err); process.exit(1); });
