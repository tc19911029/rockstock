/**
 * GET /api/valuation/{symbol}?date=YYYY-MM-DD
 *
 * 讀 data/valuation/{date}/{symbol}.json（由 valuation skill 寫入）
 * 若指定日無資料 → 回傳指定日以前最近一份，並附 ageDays 供 UI 顯示新鮮度。
 */

import { NextRequest } from 'next/server';
import { z } from 'zod';
import { apiOk, apiError, apiValidationError } from '@/lib/api/response';
import { readLatestValuation } from '@/lib/valuation/storage';

export const runtime = 'nodejs';

const querySchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
});

function ymd(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ symbol: string }> },
) {
  const { symbol: rawSymbol } = await params;
  const parsed = querySchema.safeParse(Object.fromEntries(new URL(req.url).searchParams));
  if (!parsed.success) return apiValidationError(parsed.error);

  const bareSymbol = rawSymbol.replace(/\.(TW|TWO|SS|SZ)$/i, '');
  // 路徑安全：symbol 只能 alphanumeric.-_
  if (!/^[A-Za-z0-9._-]+$/.test(bareSymbol)) {
    return apiError('invalid symbol');
  }

  const targetDate = parsed.data.date ?? ymd(new Date(Date.now() + 8 * 3600_000));

  try {
    const result = await readLatestValuation({ symbol: bareSymbol, targetDate });
    if (!result) return apiOk({ valuation: null, date: targetDate, ageDays: null });
    return apiOk(result);
  } catch (e) {
    return apiError((e as Error).message);
  }
}
