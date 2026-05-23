/**
 * Cron：盤後重算 account.json（Phase 0.3）
 *
 * 排程建議（vercel.json 或 launchd）：
 *   TW 收盤 13:30 CST + 緩衝 → 14:00 CST 跑 (UTC 06:00)
 *
 * 認證：走既有 CRON_SECRET pattern（Authorization: Bearer ...）
 */

import { NextRequest } from 'next/server';
import { apiOk, apiError } from '@/lib/api/response';
import { recalcStockValue } from '@/lib/portfolio/account';

export const runtime = 'nodejs';

export async function GET(req: NextRequest) {
  const auth = req.headers.get('authorization');
  const expected = process.env.CRON_SECRET ? `Bearer ${process.env.CRON_SECRET}` : null;
  if (expected && auth !== expected) return apiError('unauthorized', 401);

  const account = await recalcStockValue();
  return apiOk({
    cash: account.cash,
    stockValue: account.stockValue,
    totalCapital: account.totalCapital,
    asOfDate: account.asOfDate,
    holdingsCount: account.holdingsSnapshot.length,
  });
}
