/**
 * POST /api/cron/youtube-keyframes
 *
 * 關鍵幀抽取 cron — 對 keyframe_enabled 來源的 should_analyze 影片跑
 * 下載 → 場景偵測 → OCR → 初篩 → WebP（lib/youtube/keyframes.ts）。
 *
 * 慣例沿用 youtube-transcript route：
 *   - 每支處理完「立即」寫 record + index（transcript-index 2026-05-22 教訓）
 *   - sticky skip：index 已有就跳過（含 failed），重跑帶 force=1
 *   - wall-clock 預算 40 分鐘：超時停止收新影片，下個小時 tick 續跑
 *
 * Query:
 *   ?date=YYYY-MM-DD   指定日期（預設今日）
 *   ?source_id=xxx     只跑單一來源
 *   ?video_id=xxx      只跑單支（E2E 驗證用；無視 keyframe_enabled）
 *   ?force=1           已處理過也重跑
 *   ?dry_run=1         只列候選不執行
 *   ?max_videos=N      最多處理 N 支
 */

import { NextRequest } from 'next/server';
import { checkCronAuth } from '@/lib/api/cronAuth';
import { apiError, apiOk } from '@/lib/api/response';
import { todayYmdTaipei } from '@/lib/youtube/classify';
import { loadSources, loadVideosForDate } from '@/lib/youtube/videoStorage';
import { loadTranscript } from '@/lib/youtube/transcriptStorage';
import { extractKeyframes } from '@/lib/youtube/keyframes';
import {
  loadKeyframeIndex, saveKeyframeRecord, upsertKeyframeIndex,
} from '@/lib/youtube/keyframeStorage';

export const runtime = 'nodejs';
export const maxDuration = 300;
export const dynamic = 'force-dynamic';

/** 超過此 wall-clock 不再開新影片（已開始的做完）；下一個 hourly tick 續跑 */
const WALL_CLOCK_BUDGET_MS = 40 * 60_000;

export async function POST(req: NextRequest) { return handle(req); }
export async function GET(req: NextRequest) { return handle(req); }

async function handle(req: NextRequest) {
  const denied = checkCronAuth(req);
  if (denied) return denied;

  const url = new URL(req.url);
  const date = url.searchParams.get('date') || todayYmdTaipei(new Date());
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return apiError('date must be YYYY-MM-DD', 400);
  const onlySource = url.searchParams.get('source_id');
  const onlyVideo = url.searchParams.get('video_id');
  const force = url.searchParams.get('force') === '1';
  const dryRun = url.searchParams.get('dry_run') === '1';
  const maxVideos = Number(url.searchParams.get('max_videos') || 0) || Infinity;

  try {
    const [videos, sources, index] = await Promise.all([
      loadVideosForDate(date),
      loadSources(),
      loadKeyframeIndex(),
    ]);
    const enabledSources = new Set(sources.filter(s => s.keyframe_enabled).map(s => s.source_id));

    const candidates = videos.filter(v => {
      if (onlyVideo) return v.video_id === onlyVideo;
      if (!v.should_analyze) return false;
      if (v.raw?.live_status === 'is_live') return false;
      if (!enabledSources.has(v.source_id)) return false;
      if (onlySource && v.source_id !== onlySource) return false;
      return true;
    });

    if (dryRun) {
      return apiOk({
        date, dry_run: true,
        candidates: candidates.map(v => ({
          video_id: v.video_id, source_id: v.source_id, title: v.title,
          duration_sec: v.duration_sec,
          already: !!index.byId[v.video_id],
        })),
      });
    }

    const started = Date.now();
    const stats = { candidates: candidates.length, processed: 0, ok: 0, failed: 0, ocr_unavailable: 0, skipped: 0, budget_stopped: 0, total_frames_kept: 0 };
    const results: Array<{ video_id: string; status: string; frames_kept: number; error: string | null }> = [];

    for (const video of candidates) {
      if (stats.processed >= maxVideos) break;
      if (index.byId[video.video_id] && !force) { stats.skipped += 1; continue; }
      if (Date.now() - started > WALL_CLOCK_BUDGET_MS) {
        stats.budget_stopped = candidates.length - stats.processed - stats.skipped;
        break;
      }

      // 逐字稿全文給 scoreFrame 判 novel code（沒有逐字稿照樣抽幀）
      const transcript = await loadTranscript(date, video.video_id).catch(() => null);
      const transcriptText = transcript?.status === 'available' ? transcript.text : '';

      const record = await extractKeyframes(video, date, { transcriptText });

      // 每支處理完立即寫（中斷時 index 不落後實際檔案）
      await saveKeyframeRecord(record);
      await upsertKeyframeIndex(video.video_id, {
        date, status: record.status, frames_kept: record.frames_kept, extracted_at: record.extracted_at,
      });

      stats.processed += 1;
      if (record.status === 'ok') stats.ok += 1;
      else if (record.status === 'ocr_unavailable') stats.ocr_unavailable += 1;
      else stats.failed += 1;
      stats.total_frames_kept += record.frames_kept;
      results.push({
        video_id: video.video_id, status: record.status,
        frames_kept: record.frames_kept, error: record.error,
      });
    }

    return apiOk({ date, stats, results });
  } catch (err) {
    return apiError(`youtube-keyframes failed: ${(err as Error).message}`, 500);
  }
}
