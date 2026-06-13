/**
 * 回填 YouTube 老師推薦事件 — analysis/{date}.json → recommendations/{date}.json
 *
 * 用法：
 *   npx tsx scripts/backfill-youtube-recommendations.ts                       # 全部 analysis 日期
 *   npx tsx scripts/backfill-youtube-recommendations.ts --from 2026-05-18 --to 2026-06-11
 *   npx tsx scripts/backfill-youtube-recommendations.ts --dry-run             # 只看統計不寫檔
 *   npx tsx scripts/backfill-youtube-recommendations.ts --force               # analysis 沒變也重抽
 *
 * 直接呼叫 lib（不走 HTTP），結算只用 L1 本地 K 線；已結算 baseline 重跑不會被覆蓋。
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { extractAndSettleForDate } from '@/lib/youtube/recoPipeline';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const has = (name: string): boolean => process.argv.includes(`--${name}`);

async function listAnalysisDates(): Promise<string[]> {
  const dir = path.join(process.cwd(), 'data', 'youtube', 'analysis');
  const files = await fs.readdir(dir);
  return files
    .filter(f => /^\d{4}-\d{2}-\d{2}\.json$/.test(f))
    .map(f => f.replace('.json', ''))
    .sort();
}

async function main() {
  const from = arg('from') ?? '0000-00-00';
  const to = arg('to') ?? '9999-99-99';
  const dryRun = has('dry-run');
  const force = has('force');

  const dates = (await listAnalysisDates()).filter(d => d >= from && d <= to);
  console.log(`回填 ${dates.length} 天（${dates[0]} → ${dates[dates.length - 1]}）${dryRun ? ' [dry-run]' : ''}`);

  let totalEvents = 0;
  let totalScored = 0;
  const missingSymbols = new Set<string>();

  for (const date of dates) {
    const r = await extractAndSettleForDate(date, { force, dryRun });
    if (!r) { console.log(`${date}  (無 analysis 檔)`); continue; }
    const { file, stats } = r;
    const filled = file.events.filter(e => e.baseline.status === 'filled').length;
    const noFill = file.events.filter(e => e.baseline.status === 'no_fill').length;
    const noData = file.events.filter(e => e.baseline.status === 'no_data').length;
    const pending = file.events.filter(e => e.baseline.status === 'pending').length;
    const conflicts = file.events.filter(e => e.conflict).length;
    const scored = file.events.filter(e => e.cohort === 'scored' && e.baseline.status === 'filled').length;
    const persons = new Set(file.events.filter(e => e.teacher_kind === 'person').map(e => e.teacher)).size;
    totalEvents += file.events.length;
    totalScored += scored;
    for (const e of file.events) {
      if (e.baseline.status === 'no_data') missingSymbols.add(e.symbol);
    }
    console.log(
      `${date}  事件 ${String(file.events.length).padStart(3)}（評分 ${String(scored).padStart(3)}）` +
      `老師 ${String(persons).padStart(2)}  filled ${filled} / no_fill ${noFill} / no_data ${noData} / pending ${pending}` +
      `${conflicts > 0 ? `  ⚠ 衝突 ${conflicts}` : ''}` +
      `  skip(低信心 ${file.skipped.low_confidence}, 無對照 ${file.skipped.unmatched})` +
      `  [新結算 ${stats.settled}]`,
    );
  }

  console.log(`\n合計：${totalEvents} 事件、${totalScored} 筆進評分統計`);
  if (missingSymbols.size > 0) {
    console.log(`no_data 的 symbol（無 L1 K 線，可能需補抓）：${[...missingSymbols].sort().join(', ')}`);
  }
}

main().catch(err => { console.error(err); process.exit(1); });
