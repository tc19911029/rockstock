import { NextRequest } from 'next/server';
import { z } from 'zod';
import { getMonthlyRevenue } from '@/lib/datasource/FinMindClient';
import { getFundamentalsWithFallback } from '@/lib/datasource/FundamentalsFallbackChain';
import { apiOk, apiError, apiValidationError } from '@/lib/api/response';

const querySchema = z.object({
  mode: z.enum(['full', 'revenue']).default('full'),
  months: z.string().optional(),
  /** debug 用：是否回傳各源 attempt 細節 */
  debug: z.enum(['0', '1']).default('0'),
});

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ ticker: string }> },
) {
  const { ticker } = await params;
  const stockId = ticker.replace(/\.(TW|TWO)$/i, '');
  const parsed = querySchema.safeParse(Object.fromEntries(new URL(req.url).searchParams));
  if (!parsed.success) return apiValidationError(parsed.error);
  const { mode, debug } = parsed.data;

  try {
    if (mode === 'revenue') {
      const months = Math.min(24, Math.max(1, parseInt(parsed.data.months ?? '13')));
      const data = await getMonthlyRevenue(stockId, months);
      return apiOk({ data });
    }
    // 多源 fallback：FinMind 失敗自動換 TWSE
    const result = await getFundamentalsWithFallback(stockId);
    const { sourceUsed, sourceAttempts, ...data } = result;
    return apiOk(
      debug === '1'
        ? { data, sourceUsed, sourceAttempts }
        : { data, sourceUsed },
    );
  } catch (e) {
    return apiError((e as Error).message);
  }
}
