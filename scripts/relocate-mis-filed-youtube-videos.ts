/**
 * 重新依照修好後的 parseProgramDate 把每個 videos/{date}.json 內的 entry
 * 搬到正確的 day file。一次性 cleanup，下次 scan 起就用新邏輯。
 *
 * Usage: npx tsx scripts/relocate-mis-filed-youtube-videos.ts [--apply]
 *
 * 預設 dry-run，加 --apply 才真的寫盤。
 */

import { promises as fs } from 'fs';
import path from 'path';
import { parseProgramDate } from '../lib/youtube/classify';
import type { YouTubeVideo } from '../lib/youtube/types';

const VIDEOS_DIR = path.join(process.cwd(), 'data/youtube/videos');
const INDEX_PATH = path.join(process.cwd(), 'data/youtube/video-index.json');
const APPLY = process.argv.includes('--apply');

function ymdTaipei(iso: string): string {
  const d = new Date(iso);
  const tpe = new Date(d.getTime() + 8 * 3600_000);
  return tpe.toISOString().slice(0, 10);
}

function effectiveDate(v: YouTubeVideo, now: Date): string | null {
  const fromTitle = parseProgramDate(v.title, now);
  if (fromTitle) return fromTitle;
  if (v.published_at) return ymdTaipei(v.published_at);
  return null;
}

interface VideoIndex { byId: Record<string, { date: string; source_id: string }>; }

async function main() {
  const now = new Date();
  const files = (await fs.readdir(VIDEOS_DIR)).filter(f => /^\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort();

  // Map: targetDate -> array of videos that belong there
  const targetMap = new Map<string, YouTubeVideo[]>();
  const moves: Array<{ id: string; from: string; to: string; title: string }> = [];

  for (const f of files) {
    const currentDate = f.replace('.json', '');
    const fp = path.join(VIDEOS_DIR, f);
    const raw = JSON.parse(await fs.readFile(fp, 'utf-8')) as YouTubeVideo[];
    for (const v of raw) {
      const correct = effectiveDate(v, now) ?? currentDate;
      const arr = targetMap.get(correct) ?? [];
      arr.push(v);
      targetMap.set(correct, arr);
      if (correct !== currentDate) {
        moves.push({ id: v.video_id, from: currentDate, to: correct, title: v.title.slice(0, 60) });
      }
    }
  }

  console.log(`Total videos: ${[...targetMap.values()].reduce((s, a) => s + a.length, 0)}`);
  console.log(`Moves needed: ${moves.length}`);
  for (const m of moves.slice(0, 30)) {
    console.log(`  ${m.id}: ${m.from} → ${m.to}  "${m.title}"`);
  }

  if (!APPLY) {
    console.log('\n(dry-run; add --apply to write)');
    return;
  }

  // dedup within each target by video_id, prefer latest last_seen_at
  for (const [date, vids] of targetMap) {
    const byId = new Map<string, YouTubeVideo>();
    for (const v of vids) {
      const prev = byId.get(v.video_id);
      if (!prev || (v.last_seen_at ?? '') > (prev.last_seen_at ?? '')) {
        byId.set(v.video_id, v);
      }
    }
    const sorted = [...byId.values()].sort((a, b) => (b.published_at ?? '').localeCompare(a.published_at ?? ''));
    const fp = path.join(VIDEOS_DIR, `${date}.json`);
    await fs.writeFile(fp, JSON.stringify(sorted, null, 2), 'utf-8');
  }

  // Delete now-empty files (targets that had ALL their entries moved away)
  const validDates = new Set([...targetMap.keys()]);
  for (const f of files) {
    const date = f.replace('.json', '');
    if (!validDates.has(date)) {
      await fs.unlink(path.join(VIDEOS_DIR, f));
      console.log(`  deleted empty: ${f}`);
    }
  }

  // Rebuild video-index
  const newIdx: VideoIndex = { byId: {} };
  for (const [date, vids] of targetMap) {
    for (const v of vids) {
      newIdx.byId[v.video_id] = { date, source_id: v.source_id };
    }
  }
  await fs.writeFile(INDEX_PATH, JSON.stringify(newIdx, null, 2), 'utf-8');

  console.log(`\n✓ Wrote ${targetMap.size} day files + index (${Object.keys(newIdx.byId).length} entries)`);
}

main().catch(e => { console.error(e); process.exit(1); });
