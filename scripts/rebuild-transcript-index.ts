/**
 * One-off：從 data/youtube/transcripts/{date}/*.json 重建 transcript-index.json。
 *
 * 用途：當 backfill 中斷導致 index 落後時補修。
 * Usage:  npx tsx scripts/rebuild-transcript-index.ts
 */

import path from 'node:path';
import { reconcileTranscriptIndex } from '@/lib/youtube/transcriptIndexMaintenance';

const ROOT = path.join(process.cwd(), 'data', 'youtube');

async function main() {
  const result = await reconcileTranscriptIndex(ROOT);
  console.log(`scanned ${result.scanned} transcript files`);
  console.log(`index: ${result.before} → ${result.after} entries (added=${result.added}, updated=${result.updated}, removed=${result.removed})`);
}

main().catch((err) => { console.error('rebuild failed:', err); process.exit(1); });
