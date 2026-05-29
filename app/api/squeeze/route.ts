/**
 * GET /api/squeeze?symbol=6770&date=YYYY-MM-DD
 *
 * 回傳 SqueezeAnalysis：5/10/20/60d 加權空方成本、融券追繳壓力價、軋空分數、文字解讀
 */

import { NextRequest } from 'next/server';
import { z } from 'zod';
import { apiOk, apiError, apiValidationError } from '@/lib/api/response';
import { analyzeSqueeze } from '@/lib/squeeze/analyzeSqueeze';

export const dynamic = 'force-dynamic';

const querySchema = z.object({
  symbol: z.string().min(1),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
});

function todayTaipei(): string {
  const d = new Date(Date.now() + 8 * 3600 * 1000);
  return d.toISOString().slice(0, 10);
}

export async function GET(req: NextRequest): Promise<Response> {
  const url = new URL(req.url);
  const parsed = querySchema.safeParse({
    symbol: url.searchParams.get('symbol') ?? '',
    date: url.searchParams.get('date') ?? undefined,
  });
  if (!parsed.success) return apiValidationError(parsed.error);

  const { symbol, date } = parsed.data;
  const asOfDate = date ?? todayTaipei();

  try {
    const data = await analyzeSqueeze(symbol, asOfDate);
    return apiOk({ squeeze: data });
  } catch (e) {
    return apiError(e instanceof Error ? e.message : String(e), 500);
  }
}
