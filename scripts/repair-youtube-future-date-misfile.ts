/**
 * 一次性修正：標題未來日誤判把整集丟到未來檔。
 * 2026-06-18 案例：57股市同學會 KN5fvuXA0ck（6/15 上傳，標題「台積電7/16法說」）
 * 被解析成 program_date=2026-07-16 → 整集落在 videos/2026-07-16.json，6/15 分析漏掉。
 *
 * 做法（用現成 storage helper，不手改 JSON）：
 *   1) 掃描所有 videos/{date}.json，找 fileDate 晚於 published_at 台灣日的影片（未來檔誤判）
 *   2) program_date 清成 null（與修好的 parser 一致）→ 重算 should_analyze
 *   3) mergeVideosForDate 到正確日（published_at 台灣日）
 *   4) 從原未來檔移除；空檔則刪除實體檔
 *   5) 更新 video-index
 *
 * 用法：npx tsx scripts/repair-youtube-future-date-misfile.ts [--dry-run]
 */
import { promises as fs } from 'fs';
import path from 'path';
import {
  loadVideosForDate,
  saveVideosForDate,
  mergeVideosForDate,
  loadVideoIndex,
  saveVideoIndex,
} from '../lib/youtube/videoStorage';
import { decideShouldAnalyze, effectiveProgramDate, todayYmdTaipei } from '../lib/youtube/classify';
import type { YouTubeVideo } from '../lib/youtube/types';

const DRY = process.argv.includes('--dry-run');
const VIDEOS_DIR = path.join(process.cwd(), 'data/youtube/videos');

async function main() {
  const files = (await fs.readdir(VIDEOS_DIR)).filter(f => /^\d{4}-\d{2}-\d{2}\.json$/.test(f));
  const now = new Date();
  const index = await loadVideoIndex();
  let fixed = 0;

  for (const f of files.sort()) {
    const fileDate = f.replace('.json', '');
    const vids = await loadVideosForDate(fileDate);
    const stay: YouTubeVideo[] = [];
    const moved: { v: YouTubeVideo; to: string }[] = [];

    for (const v of vids) {
      const pubYmd = v.published_at ? todayYmdTaipei(new Date(v.published_at)) : null;
      // 誤判判準：這支被歸到的檔日 fileDate 晚於上傳日（節目不可能在上傳後才播）
      if (pubYmd && fileDate > pubYmd) {
        const corrected: YouTubeVideo = { ...v, program_date: null };
        const to = effectiveProgramDate(corrected) ?? pubYmd;
        const decision = decideShouldAnalyze(corrected, {
          now, alreadyAnalyzed: new Set<string>(), targetDate: to,
        });
        corrected.should_analyze = decision.should;
        corrected.skip_reason = decision.reason;
        moved.push({ v: corrected, to });
      } else {
        stay.push(v);
      }
    }

    if (moved.length === 0) continue;

    for (const { v, to } of moved) {
      console.log(`  ${v.video_id} ${fileDate} → ${to}  should_analyze=${v.should_analyze}  「${(v.title || '').slice(0, 30)}」`);
      fixed++;
      if (!DRY) {
        await mergeVideosForDate(to, [v]);
        index.byId[v.video_id] = { date: to, source_id: v.source_id };
      }
    }

    if (!DRY) {
      // 原檔移除被搬走的影片；空了就刪實體檔
      if (stay.length > 0) {
        await saveVideosForDate(fileDate, stay);
      } else {
        await saveVideosForDate(fileDate, []);
        const p = path.join(VIDEOS_DIR, f);
        await fs.unlink(p).catch(() => {});
        console.log(`  （${fileDate} 已清空，刪除實體檔）`);
      }
    }
  }

  if (!DRY && fixed > 0) {
    index.updated_at = new Date().toISOString();
    await saveVideoIndex(index);
  }
  console.log(DRY ? `\n[dry-run] 會修正 ${fixed} 支` : `\n✅ 修正 ${fixed} 支，video-index 已更新`);
}

main().catch(e => { console.error(e); process.exit(1); });
