/**
 * GET /api/broker/scorecard?start=YYYY-MM-DD&end=YYYY-MM-DD
 *
 * 各券商歷史命中率（喊完之後真的對嗎）。只統計已結算（報告後滿 20 交易日）的方向性 call。
 */

import { NextRequest } from 'next/server';
import { apiError, apiOk } from '@/lib/api/response';
import { computeScorecard } from '@/lib/broker/brokerScorecard';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const start = url.searchParams.get('start') || undefined;
  const end = url.searchParams.get('end') || undefined;
  try {
    const result = await computeScorecard({ start, end });
    return apiOk(result);
  } catch (err) {
    return apiError(`scorecard failed: ${(err as Error).message}`, 500);
  }
}
