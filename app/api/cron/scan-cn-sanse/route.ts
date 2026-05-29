import { NextRequest } from 'next/server';
import { apiOk, apiError } from '@/lib/api/response';
import { checkCronAuth } from '@/lib/api/cronAuth';
import { isTradingDay } from '@/lib/utils/tradingDay';
import { getLastTradingDay } from '@/lib/datasource/marketHours';
import { scanSanSe } from '@/lib/cn-sanse/scan';
import { saveSanSeScan } from '@/lib/cn-sanse/scanStorage';

export const runtime = 'nodejs';
export const maxDuration = 300;

// 三色資金（陸股自創策略）盤後掃描固化。?date= 回補某日；?force=1 跳過交易日檢查。
export async function GET(req: NextRequest) {
  const denied = checkCronAuth(req);
  if (denied) return denied;

  const dateParam = req.nextUrl.searchParams.get('date');
  const force = req.nextUrl.searchParams.get('force') === '1';
  const date = dateParam ?? getLastTradingDay('CN');

  if (!force && !isTradingDay(date, 'CN')) {
    return apiOk({ skipped: true, reason: 'non-trading day', date });
  }

  try {
    const result = await scanSanSe(dateParam ? { asOfDate: dateParam } : undefined);
    await saveSanSeScan(result);
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
