import { NextRequest } from 'next/server';
import { apiError, apiOk } from '@/lib/api/response';
import { todayYmdShanghai, validYmd } from '@/lib/cn-media/date';
import {
  loadCnMediaScanResults,
  loadCnMediaSources,
  loadCnMediaTranscript,
  loadCnMediaVideos,
} from '@/lib/cn-media/storage';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  const date = request.nextUrl.searchParams.get('date') || todayYmdShanghai();
  if (!validYmd(date)) return apiError('date must be YYYY-MM-DD', 400);
  const [videos, sources, scanResults] = await Promise.all([
    loadCnMediaVideos(date), loadCnMediaSources(), loadCnMediaScanResults(date),
  ]);
  const transcriptStates = await Promise.all(videos.map(async video => {
    const transcript = await loadCnMediaTranscript(date, video.video_id);
    return {
      video_id: video.video_id,
      status: transcript?.status ?? 'pending',
      quality_score: transcript?.quality_score ?? null,
      char_count: transcript?.char_count ?? 0,
      error: transcript?.error ?? null,
    };
  }));
  return apiOk({ date, videos, sources, scan_results: scanResults, transcripts: transcriptStates });
}
