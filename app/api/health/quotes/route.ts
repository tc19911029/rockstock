import { NextRequest } from 'next/server';
import { apiOk, apiError } from '@/lib/api/response';
import { getQuoteSnapshotDate } from '@/lib/datasource/marketHours';
import { runQuoteEndToEndProbe } from '@/lib/health/quoteEndToEnd';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

function baseUrl(req: NextRequest): string {
  const proto = req.headers.get('x-forwarded-proto') ?? 'http';
  const host = req.headers.get('host') ?? 'localhost:3000';
  return `${proto}://${host}`;
}

export async function GET(req: NextRequest) {
  const requested = (req.nextUrl.searchParams.get('symbols') ?? '3081.TWO,2330.TW')
    .split(',').map(value => value.trim()).filter(Boolean).slice(0, 50);
  if (requested.length === 0) return apiError('symbols required', 400);

  try {
    const result = await runQuoteEndToEndProbe({
      baseUrl: baseUrl(req),
      symbols: requested,
      expectedDate: getQuoteSnapshotDate('TW'),
      sentinels: ['3081.TWO', '2330.TW'],
    });
    return apiOk(result, {
      status: result.ok ? 200 : 503,
      headers: { 'Cache-Control': 'no-store' },
    });
  } catch (error) {
    return apiError(error instanceof Error ? error.message : String(error), 503);
  }
}
