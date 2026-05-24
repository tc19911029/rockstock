/**
 * 清掉 transcripts/{date}/ 內「video 已不在任何 videos/*.json」的 orphan transcript 檔。
 * 同時把放錯日期的 transcript 搬到正確日期目錄（按 video 實際所屬 date）。
 *
 * Usage: npx tsx scripts/cleanup-orphan-transcripts.ts [--apply]
 *
 * 預設 dry-run。
 *
 * Why：
 *   - retention 只清 videos/{date}.json 沒清對應 transcript
 *   - relocate-mis-filed-youtube-videos.ts 只搬 video entry 沒搬 transcript file
 *   結果 transcripts/ 累積大量 orphans（5/22 一天就 18 個）。
 */

import { promises as fs } from 'fs';
import path from 'path';

const ROOT = path.join(process.cwd(), 'data/youtube');
const VIDEOS_DIR = path.join(ROOT, 'videos');
const TRANSCRIPTS_DIR = path.join(ROOT, 'transcripts');
const APPLY = process.argv.includes('--apply');

interface VideoEntry { video_id: string; }

async function main() {
  // 1) Build video → its file date map (where it's currently filed)
  const videoLocation = new Map<string, string>(); // videoId -> fileDate
  for (const f of await fs.readdir(VIDEOS_DIR)) {
    if (!/^\d{4}-\d{2}-\d{2}\.json$/.test(f)) continue;
    const date = f.replace('.json', '');
    const vids = JSON.parse(await fs.readFile(path.join(VIDEOS_DIR, f), 'utf-8')) as VideoEntry[];
    for (const v of vids) videoLocation.set(v.video_id, date);
  }
  console.log(`Total videos across all day files: ${videoLocation.size}`);

  // 2) Walk transcripts/ dirs, classify each file
  const orphans: Array<{ date: string; videoId: string }> = [];
  const moves: Array<{ from: string; to: string; videoId: string }> = [];

  for (const dateDir of await fs.readdir(TRANSCRIPTS_DIR)) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dateDir)) continue;
    const fullDir = path.join(TRANSCRIPTS_DIR, dateDir);
    const stat = await fs.stat(fullDir);
    if (!stat.isDirectory()) continue;
    for (const f of await fs.readdir(fullDir)) {
      if (!f.endsWith('.json')) continue;
      const videoId = f.replace('.json', '');
      const actualDate = videoLocation.get(videoId);
      if (!actualDate) {
        orphans.push({ date: dateDir, videoId });
      } else if (actualDate !== dateDir) {
        moves.push({ from: dateDir, to: actualDate, videoId });
      }
    }
  }

  console.log(`\nOrphan transcripts (video 不在任何 videos.json): ${orphans.length}`);
  for (const o of orphans.slice(0, 30)) {
    console.log(`  ${o.date}/${o.videoId}.json`);
  }
  console.log(`\nMis-located transcripts (video 在別的 date.json): ${moves.length}`);
  for (const m of moves.slice(0, 30)) {
    console.log(`  ${m.from}/${m.videoId}.json → ${m.to}/`);
  }

  if (!APPLY) {
    console.log('\n(dry-run; 加 --apply 才會真的動)');
    return;
  }

  // 3) Apply: delete orphans, move misplaced
  let deleted = 0, moved = 0;
  for (const o of orphans) {
    const fp = path.join(TRANSCRIPTS_DIR, o.date, o.videoId + '.json');
    await fs.unlink(fp);
    deleted += 1;
  }
  for (const m of moves) {
    const src = path.join(TRANSCRIPTS_DIR, m.from, m.videoId + '.json');
    const targetDir = path.join(TRANSCRIPTS_DIR, m.to);
    await fs.mkdir(targetDir, { recursive: true });
    const dst = path.join(targetDir, m.videoId + '.json');
    // If target already has this transcript, prefer keeping the existing one
    try {
      await fs.access(dst);
      await fs.unlink(src);
      console.log(`  collision: ${m.videoId} exists at ${m.to}, deleted source at ${m.from}`);
    } catch {
      await fs.rename(src, dst);
    }
    moved += 1;
  }
  console.log(`\n✓ Deleted ${deleted} orphans, moved/resolved ${moved} mis-located`);

  // 4) Rebuild transcript-index
  console.log('\nRebuilding transcript-index.json...');
  const idx: { byId: Record<string, { date: string; status: string; quality_score: number; lang: string; char_count: number }> } = { byId: {} };
  for (const dateDir of await fs.readdir(TRANSCRIPTS_DIR)) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dateDir)) continue;
    const fullDir = path.join(TRANSCRIPTS_DIR, dateDir);
    const stat = await fs.stat(fullDir);
    if (!stat.isDirectory()) continue;
    for (const f of await fs.readdir(fullDir)) {
      if (!f.endsWith('.json')) continue;
      const videoId = f.replace('.json', '');
      try {
        const t = JSON.parse(await fs.readFile(path.join(fullDir, f), 'utf-8'));
        idx.byId[videoId] = {
          date: dateDir,
          status: t.status ?? 'available',
          quality_score: t.quality_score ?? 0,
          lang: t.lang ?? '',
          char_count: t.char_count ?? 0,
        };
      } catch { /* skip broken file */ }
    }
  }
  await fs.writeFile(path.join(ROOT, 'transcript-index.json'), JSON.stringify(idx, null, 2));
  console.log(`✓ Rebuilt index: ${Object.keys(idx.byId).length} entries`);
}

main().catch(e => { console.error(e); process.exit(1); });
