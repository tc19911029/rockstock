/**
 * 清掉沒用的影片資料：
 *   1. 整檔刪：沒對應 analysis 的舊 video files（從來沒被分析過的歷史殘片）
 *   2. Prune：保留檔內 should_analyze=true 的影片，刪掉 should=false 的（wrong_date / shorts / too_short / etc.）
 *   3. 同步 video-index：移除被刪影片的 entries
 *   4. 同步 transcript-index：移除被刪影片的 transcript（順便刪檔）
 *
 * Usage: npx tsx scripts/cleanup-useless-videos.ts [--dry-run]
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import glob from 'fast-glob';
import type { YouTubeVideo } from '../lib/youtube/types';

const DRY = process.argv.includes('--dry-run');
const ROOT = path.join(process.cwd(), 'data', 'youtube');

async function main() {
  // 1. 哪些日期有 analysis？
  const analyzedDates = new Set<string>();
  for (const fp of await glob('data/youtube/analysis/*.json')) {
    analyzedDates.add(path.basename(fp).replace('.json', ''));
  }
  console.log(`Analysis 已存在的日期: ${[...analyzedDates].sort()}`);

  const removedVideoIds = new Set<string>();
  const removedDates = new Set<string>();

  // 2. 整檔刪 + prune
  for (const fp of await glob('data/youtube/videos/*.json')) {
    const date = path.basename(fp).replace('.json', '');
    const arr: YouTubeVideo[] = JSON.parse(await fs.readFile(fp, 'utf-8'));

    if (!analyzedDates.has(date)) {
      // 整檔刪
      for (const v of arr) removedVideoIds.add(v.video_id);
      removedDates.add(date);
      if (!DRY) await fs.unlink(fp);
      console.log(`  ${DRY ? '[dry] ' : ''}rm ${path.basename(fp)} (${arr.length} videos)`);
    } else {
      // prune should=false
      const kept = arr.filter(v => v.should_analyze);
      const removed = arr.filter(v => !v.should_analyze);
      for (const v of removed) removedVideoIds.add(v.video_id);
      if (removed.length > 0) {
        console.log(`  ${DRY ? '[dry] ' : ''}prune ${path.basename(fp)}: ${arr.length} → ${kept.length}`);
        if (!DRY) await fs.writeFile(fp, JSON.stringify(kept, null, 2));
      }
    }
  }
  console.log(`\nTotal removed video_ids: ${removedVideoIds.size}`);

  // 3. 同步 video-index
  const vIdxPath = path.join(ROOT, 'video-index.json');
  const vIdx: { byId: Record<string, unknown>; updated_at: string } =
    JSON.parse(await fs.readFile(vIdxPath, 'utf-8'));
  const vIdxBefore = Object.keys(vIdx.byId).length;
  for (const vid of removedVideoIds) delete vIdx.byId[vid];
  vIdx.updated_at = new Date().toISOString();
  if (!DRY) await fs.writeFile(vIdxPath, JSON.stringify(vIdx, null, 2));
  console.log(`video-index: ${vIdxBefore} → ${Object.keys(vIdx.byId).length}`);

  // 4. 同步 transcript-index + 刪 transcript files
  const tIdxPath = path.join(ROOT, 'transcript-index.json');
  const tIdx: { byId: Record<string, unknown>; updated_at: string } =
    JSON.parse(await fs.readFile(tIdxPath, 'utf-8'));
  const tIdxBefore = Object.keys(tIdx.byId).length;
  let transcriptFilesDeleted = 0;
  for (const vid of removedVideoIds) {
    if (vid in tIdx.byId) delete tIdx.byId[vid];
    for (const fp of await glob(`data/youtube/transcripts/*/${vid}.json`)) {
      if (!DRY) await fs.unlink(fp);
      transcriptFilesDeleted++;
    }
  }
  tIdx.updated_at = new Date().toISOString();
  if (!DRY) await fs.writeFile(tIdxPath, JSON.stringify(tIdx, null, 2));
  console.log(`transcript-index: ${tIdxBefore} → ${Object.keys(tIdx.byId).length}`);
  console.log(`transcript files deleted: ${transcriptFilesDeleted}`);

  // 5. 刪空的 transcript dir
  for (const date of removedDates) {
    const dir = path.join(ROOT, 'transcripts', date);
    try {
      const items = await fs.readdir(dir);
      if (items.length === 0) {
        if (!DRY) await fs.rmdir(dir);
        console.log(`  rmdir transcripts/${date}/`);
      }
    } catch { /* dir doesn't exist */ }
  }

  console.log('\nDone.');
}

main().catch(e => { console.error(e); process.exit(1); });
