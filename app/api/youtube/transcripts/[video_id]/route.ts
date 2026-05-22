/**
 * GET /api/youtube/transcripts/[video_id]?date=YYYY-MM-DD
 *
 * 回傳單一影片的完整逐字稿（含 cues）。
 * 預設 date = 今日 (Asia/Taipei)；找不到時 fallback：用 transcript-index 查實際儲存日期。
 */

import { NextRequest } from 'next/server';
import { apiError, apiOk } from '@/lib/api/response';
import { todayYmdTaipei } from '@/lib/youtube/classify';
import {
  loadTranscript,
  loadTranscriptIndex,
} from '@/lib/youtube/transcriptStorage';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ video_id: string }> },
) {
  const { video_id } = await params;
  if (!video_id || !/^[\w-]{8,15}$/.test(video_id)) {
    return apiError('invalid video_id', 400);
  }
  const url = new URL(req.url);
  const dateParam = url.searchParams.get('date');

  try {
    // 試 query 帶的 date，沒帶就用今日
    let date = dateParam || todayYmdTaipei(new Date());
    let rec = await loadTranscript(date, video_id);
    if (!rec) {
      // fallback：查 index 找實際存的日期
      const idx = await loadTranscriptIndex();
      const entry = idx.byId[video_id];
      if (entry && entry.date !== date) {
        date = entry.date;
        rec = await loadTranscript(date, video_id);
      }
    }
    if (!rec) {
      return apiError('transcript not found — run /api/cron/youtube-transcript first', 404);
    }
    return apiOk({ transcript: rec });
  } catch (err) {
    return apiError(`loadTranscript failed: ${(err as Error).message}`, 500);
  }
}
