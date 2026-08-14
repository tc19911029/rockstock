import { NextRequest } from 'next/server';
import { checkCronAuth } from '@/lib/api/cronAuth';
import { apiError, apiOk } from '@/lib/api/response';
import { todayYmdShanghai, validYmd } from '@/lib/cn-media/date';
import { scanCnMedia } from '@/lib/cn-media/scan';

export const runtime = 'nodejs';
export const maxDuration = 120;
export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) { return handle(request); }
export async function POST(request: NextRequest) { return handle(request); }

async function handle(request: NextRequest) {
  const denied = checkCronAuth(request);
  if (denied) return denied;
  const date = request.nextUrl.searchParams.get('date') || todayYmdShanghai();
  if (!validYmd(date)) return apiError('date must be YYYY-MM-DD', 400);
  const result = await scanCnMedia(date);
  const failures = result.results.filter(item => item.error);
  return apiOk({
    date,
    videos_found: result.videos.length,
    sources_scanned: result.results.length,
    failures: failures.length,
    results: result.results,
  }, failures.length === result.results.length && failures.length > 0 ? { status: 502 } : undefined);
}
