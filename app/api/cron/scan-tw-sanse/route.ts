import { NextRequest } from 'next/server';
import { apiOk, apiError } from '@/lib/api/response';
import { checkCronAuth } from '@/lib/api/cronAuth';
import { isTradingDay } from '@/lib/utils/tradingDay';
import { getLastTradingDay } from '@/lib/datasource/marketHours';
import { scanTwSanSe } from '@/lib/tw-sanse/scan';
import { saveTwSanSeScan } from '@/lib/tw-sanse/scanStorage';
import { degenerateScanReason } from '@/lib/cn-sanse/scanGuard';
import { assertL1Coverage } from '@/lib/scanner/coverageGuard';

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

  const coverage = await assertL1Coverage('TW', date);
  if (!coverage.ok) {
    return apiError(`TW ${date} L1 coverage insufficient: ${coverage.reason}`, 503);
  }

  try {
    const result = await scanTwSanSe(dateParam ? { asOfDate: dateParam } : undefined);
    // 退化掃描防呆：指數封存落後個股（早班 16:00 撞指數 ~16:39 才封）會讓全市場被判 stale、
    // lastDate 錯標成前一日。此時不存檔，避免把前一日的好紀錄覆蓋成近乎空的結果；
    // 交給 18:35 最終版（資料齊全後）重產。見 lib/cn-sanse/scanGuard.ts。
    const degenerate = degenerateScanReason(result);
    if (degenerate) {
      return apiError(
        `TW SanSe ${result.lastDate} degenerate: ${degenerate}; evaluated=${result.evaluated}; stale=${result.staleSkipped}`,
        503,
      );
    }
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
