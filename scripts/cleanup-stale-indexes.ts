/**
 * 修復 video-index / transcript-index 的 stale entries。
 *
 * 問題：scrub-archived-sources.ts 對 index 結構誤判（沒處理 byId wrapper），
 *       導致刪 video metadata 後 index 沒同步。
 *
 * 此腳本：以「實際 videos 檔 + transcripts 檔」為真，把 index 多餘的 entries 移除。
 *
 * Usage: npx tsx scripts/cleanup-stale-indexes.ts
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import glob from 'fast-glob';

const ROOT = path.join(process.cwd(), 'data', 'youtube');

async function main() {
  // ── video-index ─────────────────────────────────────────────
  const vIdxPath = path.join(ROOT, 'video-index.json');
  const vIdx: { byId: Record<string, unknown>; updated_at: string } =
    JSON.parse(await fs.readFile(vIdxPath, 'utf-8'));

  const actualVids = new Set<string>();
  for (const fp of await glob('data/youtube/videos/*.json', { cwd: process.cwd() })) {
    const arr = JSON.parse(await fs.readFile(fp, 'utf-8'));
    for (const v of arr) actualVids.add(v.video_id);
  }

  const vIdxBefore = Object.keys(vIdx.byId).length;
  for (const vid of Object.keys(vIdx.byId)) {
    if (!actualVids.has(vid)) delete vIdx.byId[vid];
  }
  const vIdxAfter = Object.keys(vIdx.byId).length;
  vIdx.updated_at = new Date().toISOString();
  await fs.writeFile(vIdxPath, JSON.stringify(vIdx, null, 2));
  console.log(`video-index.json: ${vIdxBefore} → ${vIdxAfter} (removed ${vIdxBefore - vIdxAfter} stale)`);

  // ── transcript-index ────────────────────────────────────────
  const tIdxPath = path.join(ROOT, 'transcript-index.json');
  const tIdx: { byId: Record<string, unknown>; updated_at: string } =
    JSON.parse(await fs.readFile(tIdxPath, 'utf-8'));

  const actualTranscripts = new Set<string>();
  for (const fp of await glob('data/youtube/transcripts/*/*.json', { cwd: process.cwd() })) {
    const vid = path.basename(fp).replace('.json', '');
    actualTranscripts.add(vid);
  }

  const tIdxBefore = Object.keys(tIdx.byId).length;
  for (const vid of Object.keys(tIdx.byId)) {
    if (!actualTranscripts.has(vid)) delete tIdx.byId[vid];
  }
  const tIdxAfter = Object.keys(tIdx.byId).length;
  tIdx.updated_at = new Date().toISOString();
  await fs.writeFile(tIdxPath, JSON.stringify(tIdx, null, 2));
  console.log(`transcript-index.json: ${tIdxBefore} → ${tIdxAfter} (removed ${tIdxBefore - tIdxAfter} stale)`);
}

main().catch(e => { console.error(e); process.exit(1); });
