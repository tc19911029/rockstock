import { NextRequest } from 'next/server';
import { checkCronAuth } from '@/lib/api/cronAuth';
import { apiError, apiOk } from '@/lib/api/response';
import { todayYmdShanghai, validYmd } from '@/lib/cn-media/date';
import { buildCnMediaQuestion, writeCnMediaQuestion } from '@/lib/cn-media/questionBuilder';

export const runtime = 'nodejs';
export const maxDuration = 180;
export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) { return handle(request); }
export async function POST(request: NextRequest) { return handle(request); }

async function handle(request: NextRequest) {
  const denied = checkCronAuth(request);
  if (denied) return denied;
  const date = request.nextUrl.searchParams.get('date') || todayYmdShanghai();
  if (!validYmd(date)) return apiError('date must be YYYY-MM-DD', 400);
  const payload = await buildCnMediaQuestion(date);
  const questionPath = await writeCnMediaQuestion(payload);
  return apiOk({
    date,
    question_path: questionPath,
    output_path: payload.output_path,
    videos_with_transcript: payload.videos.length,
    stock_candidates: payload.stock_candidates.length,
    stock_data_bundles: payload.stock_data_bundles.length,
    source_availability: payload.source_transcript_availability,
  });
}
