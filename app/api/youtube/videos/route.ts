/**
 * GET /api/youtube/videos?date=YYYY-MM-DD&source_id=...&should_analyze=true&strict=1
 *
 * 預設 date = 今日 (Asia/Taipei)；strict=1（預設）只回 published_at 落在該日的影片，
 * 避免 videos/{date}.json 內跨日污染（scan 觸發日 ≠ published 日）。
 * strict=0 → 回 file 全部內容（debug 用）。
 */

import { NextRequest } from 'next/server';
import { apiError, apiOk } from '@/lib/api/response';
import { todayYmdTaipei } from '@/lib/youtube/classify';
import { loadVideosForDate } from '@/lib/youtube/videoStorage';
import { loadTranscriptIndex } from '@/lib/youtube/transcriptStorage';
import type { TranscriptIndexEntry } from '@/lib/youtube/transcriptStorage';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function ymdTaipei(iso: string): string | null {
  try {
    const t = new Date(new Date(iso).getTime() + 8 * 3600_000);
    return `${t.getUTCFullYear()}-${String(t.getUTCMonth() + 1).padStart(2, '0')}-${String(t.getUTCDate()).padStart(2, '0')}`;
  } catch { return null; }
}

export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const date = url.searchParams.get('date') || todayYmdTaipei(new Date());
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return apiError('date must be YYYY-MM-DD', 400);
  }
  const sourceId = url.searchParams.get('source_id');
  const shouldAnalyzeParam = url.searchParams.get('should_analyze');
  const strict = url.searchParams.get('strict') !== '0';  // 預設 strict

  try {
    let videos = await loadVideosForDate(date);
    if (strict) {
      // 只回 published_at 真的落在 date 內的影片（避免跨日污染）
      videos = videos.filter(v => {
        if (!v.published_at) return false;
        return ymdTaipei(v.published_at) === date;
      });
    }
    if (sourceId) videos = videos.filter(v => v.source_id === sourceId);
    if (shouldAnalyzeParam === 'true') videos = videos.filter(v => v.should_analyze);
    if (shouldAnalyzeParam === 'false') videos = videos.filter(v => !v.should_analyze);

    // Join transcript-index（每 request 一次 load 即可，輕量）
    const idx = await loadTranscriptIndex();
    const enriched = videos.map(v => {
      const t: TranscriptIndexEntry | undefined = idx.byId[v.video_id];
      return {
        ...v,
        transcript_status: t?.status ?? 'pending',
        transcript_quality_score: t?.quality_score ?? null,
        transcript_lang: t?.lang ?? null,
        transcript_char_count: t?.char_count ?? null,
      };
    });

    return apiOk({ date, count: enriched.length, videos: enriched });
  } catch (err) {
    return apiError(`loadVideosForDate failed: ${(err as Error).message}`, 500);
  }
}
