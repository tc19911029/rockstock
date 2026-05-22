/**
 * 強制重新 classify videos/{date}.json，套用嚴格 targetDate 過濾。
 *
 * 用途：當 scan 跑歷史時用了錯的 targetDate（或沒用），導致 should_analyze 計算錯。
 *
 * Usage: npx tsx scripts/reclassify-videos.ts [YYYY-MM-DD]
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { decideShouldAnalyze, videoConfidenceScore } from '../lib/youtube/classify';
import { defaultSources } from '../lib/youtube/sourceRegistry';
import type { YouTubeVideo } from '../lib/youtube/types';

async function main() {
  const date = process.argv[2] || new Date(Date.now() + 8*3600_000).toISOString().slice(0,10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    console.error('date must be YYYY-MM-DD'); process.exit(1);
  }

  const filePath = path.join(process.cwd(), 'data', 'youtube', 'videos', `${date}.json`);
  const arr: YouTubeVideo[] = JSON.parse(await fs.readFile(filePath, 'utf-8'));
  console.log(`Loaded ${arr.length} videos from ${date}.json`);

  const sources = new Map(defaultSources().map(s => [s.source_id, s]));
  const now = new Date();
  let changes = 0;
  let analyzableBefore = arr.filter(v => v.should_analyze).length;
  for (const v of arr) {
    const source = sources.get(v.source_id);
    if (!source) continue;
    const d = decideShouldAnalyze(v, { now, alreadyAnalyzed: new Set(), targetDate: date });
    const sa = d.should;
    const sr = d.reason;
    if (v.should_analyze !== sa || v.skip_reason !== sr) {
      v.should_analyze = sa;
      v.skip_reason = sr;
      changes++;
    }
    v.video_confidence_score = videoConfidenceScore(v, source, now);
  }
  let analyzableAfter = arr.filter(v => v.should_analyze).length;

  await fs.writeFile(filePath, JSON.stringify(arr, null, 2));
  console.log(`Changes: ${changes} videos updated`);
  console.log(`Analyzable: ${analyzableBefore} → ${analyzableAfter}`);
}

main().catch(e => { console.error(e); process.exit(1); });
