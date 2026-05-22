/**
 * One-off：從 data/youtube/transcripts/{date}/*.json 重建 transcript-index.json。
 *
 * 用途：當 backfill 中斷導致 index 落後時補修。
 * Usage:  npx tsx scripts/rebuild-transcript-index.ts
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';

const ROOT = path.join(process.cwd(), 'data', 'youtube');
const TRANSCRIPTS_DIR = path.join(ROOT, 'transcripts');
const INDEX_PATH = path.join(ROOT, 'transcript-index.json');

async function main() {
  let existingIndex: Record<string, unknown> = { byId: {}, updated_at: new Date(0).toISOString() };
  try {
    const raw = await fs.readFile(INDEX_PATH, 'utf-8');
    existingIndex = JSON.parse(raw);
  } catch { /* not exist */ }

  const byId = (existingIndex as { byId: Record<string, unknown> }).byId ?? {};
  const beforeCount = Object.keys(byId).length;

  const dates = await fs.readdir(TRANSCRIPTS_DIR).catch(() => []);
  let scanned = 0;
  let added = 0;
  let updated = 0;

  for (const date of dates) {
    const dateDir = path.join(TRANSCRIPTS_DIR, date);
    const stat = await fs.stat(dateDir);
    if (!stat.isDirectory()) continue;

    const files = await fs.readdir(dateDir);
    for (const file of files) {
      if (!file.endsWith('.json')) continue;
      scanned++;
      const filePath = path.join(dateDir, file);
      const rec = JSON.parse(await fs.readFile(filePath, 'utf-8'));
      const videoId = rec.video_id ?? file.replace('.json', '');
      const entry = {
        status: rec.status,
        quality_score: rec.quality_score,
        lang: rec.lang,
        char_count: rec.char_count,
        fetched_at: rec.fetched_at,
        date: rec.date,
      };
      const prev = byId[videoId] as { status?: string; char_count?: number } | undefined;
      if (!prev) {
        byId[videoId] = entry;
        added++;
      } else if (prev.status !== rec.status || prev.char_count !== rec.char_count) {
        // 例：先前 unavailable，現在檔案有內容了 → 更新
        byId[videoId] = entry;
        updated++;
      }
    }
  }

  const newIndex = {
    byId,
    updated_at: new Date().toISOString(),
  };
  await fs.writeFile(INDEX_PATH, JSON.stringify(newIndex, null, 2));

  console.log(`scanned ${scanned} transcript files`);
  console.log(`index: ${beforeCount} → ${Object.keys(byId).length} entries (added=${added}, updated=${updated})`);
}

main().catch((err) => { console.error('rebuild failed:', err); process.exit(1); });
