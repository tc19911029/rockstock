/**
 * 回填 hard_score_v0 事件 — 跨歷史日建事件 + 結算，餵「模式×情緒階段」交叉勝率表（P4）
 *
 * 為什麼能回填：limitup-pool（漲停/炸板池）已全量回填 492 天，hard_score 的漲停結構子分
 * 只靠 pool 就能算（龍虎榜/主力/人氣歷史多缺 → 那些子分 null 自動重加權）。所以歷史事件
 * = 「pool 驅動的打板/低吸候選」，正好是短線情緒系統要驗證的核心 universe。
 *
 * 結算用 settleBaseline（隔日開盤進場、一字 no_fill）+ K 線（主板 L1 / 創業科創 _klines-cache），
 * 全是事件日之後的真實 K，無 look-ahead。報酬不持久化，讀取時即時 derive（leaderboard）。
 *
 * 用法：npx tsx scripts/backfill-cn-events.ts [--from 2024-06-01] [--force]
 */

import { config as loadEnv } from 'dotenv';
loadEnv({ path: '.env.local' });
loadEnv();

import { listBreadthDates, readRecoEvents } from '@/lib/cn-agents/storage';
import { buildHardScoreEvents } from '@/lib/cn-agents/hardScore';
import { settlePendingEvents } from '@/lib/cn-agents/backtest/recoPipeline';

function arg(flag: string): string | null {
  const i = process.argv.indexOf(flag);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : null;
}

async function main(): Promise<void> {
  const force = process.argv.includes('--force');
  const from = arg('--from') ?? '2024-06-01';
  const dates = (await listBreadthDates()).filter((d) => d >= from);
  console.log(`📅 回填 hard_score 事件：${dates.length} 個交易日（${dates[0]} ~ ${dates[dates.length - 1]}）${force ? '【--force】' : ''}`);

  let built = 0, skipped = 0, failed = 0;
  for (let i = 0; i < dates.length; i++) {
    const date = dates[i];
    try {
      if (!force) {
        const existing = await readRecoEvents(date);
        if (existing && existing.events.some((e) => e.agentSource === 'hard_score_v0')) { skipped++; continue; }
      }
      const file = await buildHardScoreEvents(date);
      built += file.events.length > 0 ? 1 : 0;
    } catch (err) {
      failed++;
      if (failed <= 5) console.warn(`  ⚠️ ${date} 建事件失敗：${err instanceof Error ? err.message.slice(0, 100) : err}`);
    }
    if ((i + 1) % 50 === 0 || i === dates.length - 1) {
      console.log(`  建事件 ${i + 1}/${dates.length}（新建 ${built}、跳過 ${skipped}、失敗 ${failed}）`);
    }
  }

  console.log('🧮 結算所有 pending 事件 baseline（隔日開盤進場、一字 no_fill）…');
  const stats = await settlePendingEvents({ maxDates: dates.length + 10 });
  console.log(`✅ 結算：掃 ${stats.scanned}、filled ${stats.filled}、no_fill ${stats.noFill}、no_data ${stats.noData}、pending ${stats.pending}`);
  console.log('🎉 完成。跑 scripts/report-cn-crosstable.ts 看模式×情緒階段勝率，或 /api/cn-agents/leaderboard');
}

main().catch((err) => { console.error('回填中斷：', err); process.exit(1); });
