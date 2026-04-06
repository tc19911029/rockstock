import { NextRequest } from 'next/server';
import { z } from 'zod';
import { MarketId, MtfMode } from '@/lib/scanner/types';
import { listScanDates, loadScanSession } from '@/lib/storage/scanStorage';
import { apiOk, apiError, apiValidationError } from '@/lib/api/response';

export const runtime = 'nodejs';

const querySchema = z.object({
  market: z.enum(['TW', 'CN']).default('TW'),
  direction: z.enum(['long', 'short']).default('long'),
  mtf: z.enum(['daily', 'mtf']).optional(),
  date: z.string().optional(),
});

export async function GET(req: NextRequest) {
  const parsed = querySchema.safeParse(Object.fromEntries(new URL(req.url).searchParams));
  if (!parsed.success) return apiValidationError(parsed.error);
  const market: MarketId = parsed.data.market;
  const direction = parsed.data.direction;
  const mtfMode = parsed.data.mtf as MtfMode | undefined;
  const dateParam = parsed.data.date;

  try {
    if (dateParam) {
      // Return the specific date session (full data)
      const session = await loadScanSession(market, dateParam, direction, mtfMode ?? 'daily');
      if (!session) return apiOk({ sessions: [] });
      return apiOk({ sessions: [session] });
    }

    // Return all available dates (summary only)
    const dates = await listScanDates(market, direction, mtfMode);
    const sessions = dates.map(d => ({
      id: `${d.market}-${d.direction ?? 'long'}-${d.mtfMode ?? 'daily'}-${d.date}`,
      market: d.market,
      date: d.date,
      direction: d.direction,
      mtfMode: d.mtfMode,
      scanTime: d.scanTime,
      resultCount: d.resultCount,
    }));

    return apiOk({ sessions });
  } catch (err: unknown) {
    console.error('[scanner/results] error:', err);
    return apiError('掃描服務暫時無法使用');
  }
}
