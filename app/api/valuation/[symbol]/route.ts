/**
 * GET /api/valuation/{symbol}?date=YYYY-MM-DD
 *
 * 讀 data/valuation/{date}/{symbol}.json（由 valuation skill 寫入）
 * 若無 → 嘗試找近 7 天最新一份，回 { ok: true, valuation: null, fallbackDate?: ... }
 */

import { NextRequest } from 'next/server';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { apiOk, apiError, apiValidationError } from '@/lib/api/response';

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
    // 試指定日
    const primaryPath = path.join(process.cwd(), 'data', 'valuation', targetDate, `${bareSymbol}.json`);
    try {
      const raw = await fs.readFile(primaryPath, 'utf-8');
      return apiOk({ valuation: JSON.parse(raw), date: targetDate });
    } catch { /* 找不到 → 退而求其次找近 7 天 */ }

    for (let i = 1; i <= 7; i++) {
      const d = new Date(targetDate);
      d.setDate(d.getDate() - i);
      const fallbackDate = ymd(d);
      const fbPath = path.join(process.cwd(), 'data', 'valuation', fallbackDate, `${bareSymbol}.json`);
      try {
        const raw = await fs.readFile(fbPath, 'utf-8');
        return apiOk({ valuation: JSON.parse(raw), date: fallbackDate, fellBackFrom: targetDate });
      } catch { /* try next */ }
    }

    return apiOk({ valuation: null, date: targetDate });
  } catch (e) {
    return apiError((e as Error).message);
  }
}
