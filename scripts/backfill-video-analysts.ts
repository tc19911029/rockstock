/**
 * One-off: 把 existing videos/{date}.json 裡每支影片的 analysts 欄位補上。
 *
 * 用法：npx tsx scripts/backfill-video-analysts.ts [date1 date2 ...]
 *      不帶參數 → 處理 data/youtube/videos/ 下所有 file
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { resolveAnalystsForVideo } from '../lib/youtube/analystParser';
import type { YouTubeSource, YouTubeVideo } from '../lib/youtube/types';

const VIDEOS_DIR = path.join(process.cwd(), 'data/youtube/videos');
const SOURCES_PATH = path.join(process.cwd(), 'data/youtube/sources.json');

async function main() {
  const sources = JSON.parse(await fs.readFile(SOURCES_PATH, 'utf-8')) as YouTubeSource[];
  const sourceMap = new Map(sources.map(s => [s.source_id, s]));

  let onlyDates = process.argv.slice(2);
  if (onlyDates.length === 0) {
    const files = await fs.readdir(VIDEOS_DIR);
    onlyDates = files.filter(f => /^\d{4}-\d{2}-\d{2}\.json$/.test(f)).map(f => f.slice(0, 10));
  }

  let totalFiles = 0;
  let totalVideos = 0;
  let totalPatched = 0;

  for (const d of onlyDates) {
    const file = path.join(VIDEOS_DIR, `${d}.json`);
    let raw: string;
    try {
      raw = await fs.readFile(file, 'utf-8');
    } catch {
      console.log(`[skip] ${d}: file not found`);
      continue;
    }
    const arr = JSON.parse(raw) as YouTubeVideo[];
    let patched = 0;
    for (const v of arr) {
      const src = sourceMap.get(v.source_id);
      const newAnalysts = resolveAnalystsForVideo(v.title, src?.default_analysts, src?.display_name);
      if (!Array.isArray(v.analysts) || v.analysts.length === 0 ||
          JSON.stringify(v.analysts) !== JSON.stringify(newAnalysts)) {
        v.analysts = newAnalysts;
        patched += 1;
      }
    }
    await fs.writeFile(file, JSON.stringify(arr, null, 2));
    console.log(`[done] ${d}: ${patched}/${arr.length} patched`);
    totalFiles += 1;
    totalVideos += arr.length;
    totalPatched += patched;
  }

  console.log(`\nTotal: ${totalPatched} videos patched across ${totalFiles} files (of ${totalVideos} total).`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
