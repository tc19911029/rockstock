import { NextRequest } from 'next/server';
import { apiOk, apiError } from '@/lib/api/response';
import { checkCronAuth } from '@/lib/api/cronAuth';
import { isTradingDay } from '@/lib/utils/tradingDay';
import { getLastTradingDay } from '@/lib/datasource/marketHours';
import { scanTwSanSe } from '@/lib/tw-sanse/scan';
import { saveTwSanSeScan } from '@/lib/tw-sanse/scanStorage';

export const runtime = 'nodejs';
export const maxDuration = 300;

// 三色資金（台股自創策略）盤後掃描固化。?date= 回補某日；?force=1 跳過交易日檢查。
// ⚠️ 尚未掛 launchd / vercel cron（promote 後由使用者排程）。
export async function GET(req: NextRequest) {
  const denied = checkCronAuth(req);
  if (denied) return denied;

  const dateParam = req.nextUrl.searchParams.get('date');
  const force = req.nextUrl.searchParams.get('force') === '1';
  const date = dateParam ?? getLastTradingDay('TW');

  if (!force && !isTradingDay(date, 'TW')) {
    return apiOk({ skipped: true, reason: 'non-trading day', date });
  }

  try {
    const result = await scanTwSanSe(dateParam ? { asOfDate: dateParam } : undefined);
    await saveTwSanSeScan(result);
    return apiOk({
      ok: true,
      date: result.lastDate,
      evaluated: result.evaluated,
      staleSkipped: result.staleSkipped,
      counts: result.counts,
    });
  } catch (err) {
    return apiError(err instanceof Error ? err.message : '三色資金掃描失敗', 500);
  }
}
