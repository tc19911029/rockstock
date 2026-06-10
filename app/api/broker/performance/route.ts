/**
 * GET /api/broker/performance?date=YYYY-MM-DD
 *
 * 首頁「法人報告」tab 主資料源：某日所有券商報告 →
 * 每檔報告後 N 日漲跌幅（複用 computeNDayReturns）+ 目標價達成度 + 跨券商共識。
 *
 * date 缺省 → 用最新有報告的日期（listReportDates()[0]）。
 */

import { NextRequest } from 'next/server';
import { apiError, apiOk } from '@/lib/api/response';
import { todayYmdTaipei } from '@/lib/youtube/classify';
import { computeBrokerPerformance, type BrokerStockPerformance } from '@/lib/broker/brokerPerformance';
import { computeConsensus, type BrokerConsensusStock } from '@/lib/broker/brokerConsensus';
import { listReportDates } from '@/lib/broker/brokerStorage';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export interface BrokerPerformanceResponse {
  date: string;
  baseDate: string;
  items: BrokerStockPerformance[];
  consensus: BrokerConsensusStock[];
  availableDates: string[];
  stats: { report_count: number; item_count: number; covered_count: number };
  message?: string;
}

export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  let date = url.searchParams.get('date') || '';
  try {
    const availableDates = await listReportDates();
    if (!date) date = availableDates[0] || todayYmdTaipei(new Date());
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return apiError('date must be YYYY-MM-DD', 400);
    }

    const [perf, consensus] = await Promise.all([
      computeBrokerPerformance(date),
      computeConsensus(date, 5),
    ]);

    return apiOk<BrokerPerformanceResponse>({
      date,
      baseDate: date,
      items: perf.items,
      consensus,
      availableDates,
      stats: perf.stats,
      message: perf.message,
    });
  } catch (err) {
    return apiError(`broker performance failed: ${(err as Error).message}`, 500);
  }
}
