/**
 * 把 videos/{scanDate}.json 內的影片，依各自 published_at 重新分檔。
 *
 * 一次性 cleanup：歷史上 videos 按 scan 觸發日分檔，導致 5/22 file 內有 5/12-5/21 舊片。
 * 新版 scanRunner 已改成 按 published_at 分檔，但既有資料要 redistribute。
 *
 * 流程：
 *   1. 讀所有 videos/{date}.json
 *   2. 依 published_at 重新分組
 *   3. 寫回對應的 file（merge，不覆蓋既有條目）
 *   4. video-index 也 rebuild
 *
 * Usage: npx tsx scripts/redistribute-videos-by-pubdate.ts [--dry-run]
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import glob from 'fast-glob';
import { ymdTaipei } from '../lib/youtube/classify';
import type { YouTubeVideo } from '../lib/youtube/types';

const DRY = process.argv.includes('--dry-run');
const ROOT = path.join(process.cwd(), 'data', 'youtube');

async function main() {
  const videoFiles = await glob('data/youtube/videos/*.json', { cwd: process.cwd() });
  console.log(`Found ${videoFiles.length} video files`);

  // 1. 收集所有影片，依 published_at 重新分組
  const byPubDate = new Map<string, YouTubeVideo[]>();
  const dedup = new Map<string, YouTubeVideo>();  // video_id → latest record

  for (const fp of videoFiles) {
    const fileDate = path.basename(fp).replace('.json', '');
    const arr: YouTubeVideo[] = JSON.parse(await fs.readFile(fp, 'utf-8'));
    for (const v of arr) {
      // 已 dedup 過就跳過（保留先看到的，merge 時應該都一樣）
      if (dedup.has(v.video_id)) continue;
      dedup.set(v.video_id, v);
      const pubDate = v.published_at ? ymdTaipei(new Date(v.published_at)) : fileDate;
      const list = byPubDate.get(pubDate) ?? [];
      list.push(v);
      byPubDate.set(pubDate, list);
    }
  }

  console.log(`Total unique videos: ${dedup.size}`);
  console.log(`Will redistribute into ${byPubDate.size} files:`);
  for (const [date, vs] of [...byPubDate.entries()].sort()) {
    console.log(`  videos/${date}.json: ${vs.length} videos`);
  }

  if (DRY) {
    console.log('\n[dry] no writes');
    return;
  }

  // 2. 清掉舊 files，寫新分檔
  for (const fp of videoFiles) {
    await fs.unlink(fp);
  }
  for (const [date, vids] of byPubDate.entries()) {
    const sorted = [...vids].sort(
      (a, b) => (b.published_at ?? '').localeCompare(a.published_at ?? ''),
    );
    const target = path.join(ROOT, 'videos', `${date}.json`);
    await fs.writeFile(target, JSON.stringify(sorted, null, 2));
  }

  // 3. Rebuild video-index
  const byId: Record<string, { date: string; source_id: string }> = {};
  for (const [pubDate, vids] of byPubDate.entries()) {
    for (const v of vids) {
      byId[v.video_id] = { date: pubDate, source_id: v.source_id };
    }
  }
  await fs.writeFile(
    path.join(ROOT, 'video-index.json'),
    JSON.stringify({ byId, updated_at: new Date().toISOString() }, null, 2),
  );
  console.log(`\nWrote video-index.json with ${Object.keys(byId).length} entries`);
  console.log('Done.');
}

main().catch(e => { console.error(e); process.exit(1); });
