/**
 * 從現有 videos/{date}.json 重建 scan-logs/{date}.json 的 analyzable/skipped 計數。
 * 用於 reclassify-videos 跑完後同步 health snapshot。
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { YouTubeVideo, YouTubeSourceScanLog } from '../lib/youtube/types';

async function main() {
  const date = process.argv[2] || new Date(Date.now() + 8*3600_000).toISOString().slice(0,10);
  const videosPath = path.join(process.cwd(), 'data', 'youtube', 'videos', `${date}.json`);
  const logsPath   = path.join(process.cwd(), 'data', 'youtube', 'scan-logs', `${date}.json`);

  const videos: YouTubeVideo[] = JSON.parse(await fs.readFile(videosPath, 'utf-8'));
  const logs: YouTubeSourceScanLog[] = JSON.parse(await fs.readFile(logsPath, 'utf-8'));

  // 重算每 source 的 analyzable / skipped
  const counts = new Map<string, { analyz: number; skipped: number; scanned: number }>();
  for (const v of videos) {
    const c = counts.get(v.source_id) ?? { analyz: 0, skipped: 0, scanned: 0 };
    c.scanned += 1;
    if (v.should_analyze) c.analyz += 1;
    else c.skipped += 1;
    counts.set(v.source_id, c);
  }

  for (const log of logs) {
    const c = counts.get(log.source_id);
    if (!c) continue;
    log.analyzable_count = c.analyz;
    log.skipped_count = c.skipped;
    // 不改 scanned_count — 那是 yt-dlp 抓到的原始數
  }
  await fs.writeFile(logsPath, JSON.stringify(logs, null, 2));
  console.log(`Rebuilt scan-logs/${date}.json with corrected analyzable counts`);
  for (const l of logs) {
    console.log(`  ${l.source_id}: scanned=${l.scanned_count} analyz=${l.analyzable_count} skipped=${l.skipped_count}`);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
