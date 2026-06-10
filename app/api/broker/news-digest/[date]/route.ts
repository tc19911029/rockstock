/**
 * GET /api/broker/news-digest/[date]
 *
 * 回傳某日消息面 digest（晨報新聞 × 持股/法人報告 對照）。
 * date 可為 'latest' → 取最新一份。
 */

import { NextRequest } from 'next/server';
import { apiError, apiOk } from '@/lib/api/response';
import { loadNewsDigest, listNewsDigestDates } from '@/lib/broker/newsDigest';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ date: string }> },
) {
  const { date } = await params;
  try {
    const availableDates = await listNewsDigestDates();
    const target = date === 'latest' ? (availableDates[0] ?? '') : date;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(target)) {
      return apiOk({ digest: null, availableDates, message: '尚無消息面 digest' });
    }
    const digest = await loadNewsDigest(target);
    return apiOk({ digest, availableDates, message: digest ? undefined : '此日無消息面 digest' });
  } catch (err) {
    return apiError(`news-digest failed: ${(err as Error).message}`, 500);
  }
}
