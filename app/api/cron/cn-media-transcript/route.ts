import { NextRequest } from 'next/server';
import { checkCronAuth } from '@/lib/api/cronAuth';
import { apiError, apiOk } from '@/lib/api/response';
import { todayYmdShanghai, validYmd } from '@/lib/cn-media/date';
import {
  loadCnMediaTranscript,
  loadCnMediaVideos,
  saveCnMediaTranscript,
} from '@/lib/cn-media/storage';
import { transcribeCnMediaVideo } from '@/lib/cn-media/transcribe';

export const runtime = 'nodejs';
export const maxDuration = 3600;
export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) { return handle(request); }
export async function POST(request: NextRequest) { return handle(request); }

async function handle(request: NextRequest) {
  const denied = checkCronAuth(request);
  if (denied) return denied;
  const date = request.nextUrl.searchParams.get('date') || todayYmdShanghai();
  const force = request.nextUrl.searchParams.get('force') === '1';
  const sourceId = request.nextUrl.searchParams.get('source_id');
  if (!validYmd(date)) return apiError('date must be YYYY-MM-DD', 400);

  const videos = (await loadCnMediaVideos(date)).filter(video => !sourceId || video.source_id === sourceId);
  const results = [];
  for (const video of videos) {
    const existing = await loadCnMediaTranscript(date, video.video_id);
    if (!force && existing?.status === 'available') {
      results.push({ video_id: video.video_id, source_id: video.source_id, status: existing.status, skipped: true });
      continue;
    }
    const record = await transcribeCnMediaVideo(video);
    await saveCnMediaTranscript(record);
    results.push({
      video_id: video.video_id,
      source_id: video.source_id,
      status: record.status,
      quality_score: record.quality_score,
      char_count: record.char_count,
      error: record.error,
      skipped: false,
    });
  }
  return apiOk({
    date,
    videos: videos.length,
    available: results.filter(item => item.status === 'available').length,
    failed: results.filter(item => item.status === 'failed').length,
    results,
  });
}
