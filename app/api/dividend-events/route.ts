import type { NextRequest } from 'next/server';
import { getFinMindToken } from '@/lib/env';
import { normalizeCashDividendEvents } from '@/lib/analysis/dividendEvents';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const FINMIND_API = 'https://api.finmindtrade.com/api/v4/data';

function ymdPlusDays(ymd: string, days: number): string {
  const date = new Date(`${ymd}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

export async function GET(request: NextRequest) {
  const symbol = request.nextUrl.searchParams.get('symbol')?.replace(/\.(TW|TWO)$/i, '') ?? '';
  const asOf = request.nextUrl.searchParams.get('asOf') ?? '';
  if (!/^\d{4}$/.test(symbol) || !/^\d{4}-\d{2}-\d{2}$/.test(asOf)) {
    return Response.json({ ok: false, error: 'invalid_symbol_or_date', events: [] }, { status: 400 });
  }

  const token = getFinMindToken();
  if (!token) {
    return Response.json({ ok: true, events: [], sourceAvailable: false, asOf });
  }

  const horizonEnd = ymdPlusDays(asOf, 45);
  const queryStart = `${asOf.slice(0, 4)}-01-01`;
  // FinMind 用股利基準日過濾；基準日通常晚於除息日，因此查詢尾端額外放寬。
  const queryEnd = ymdPlusDays(horizonEnd, 120);
  const url = new URL(FINMIND_API);
  url.searchParams.set('dataset', 'TaiwanStockDividend');
  url.searchParams.set('data_id', symbol);
  url.searchParams.set('start_date', queryStart);
  url.searchParams.set('end_date', queryEnd);
  url.searchParams.set('token', token);

  try {
    const response = await fetch(url, {
      headers: { Accept: 'application/json' },
      next: { revalidate: 6 * 60 * 60 },
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error(`FinMind HTTP ${response.status}`);
    const payload = await response.json() as { status?: number; data?: unknown[] };
    if (payload.status !== 200) throw new Error(`FinMind status ${payload.status ?? 'unknown'}`);

    const events = normalizeCashDividendEvents(
      (payload.data ?? []) as Parameters<typeof normalizeCashDividendEvents>[0],
      asOf,
      horizonEnd,
      asOf,
    );
    return Response.json({ ok: true, events, sourceAvailable: true, asOf });
  } catch (error) {
    console.error('[dividend-events] fetch failed', error instanceof Error ? error.message : error);
    return Response.json({ ok: true, events: [], sourceAvailable: false, asOf });
  }
}
