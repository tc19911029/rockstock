/**
 * GET /api/broker/stocks/[code]
 *
 * 單一股票的法人報告時間軸：歷來哪些券商在哪天怎麼喊、報告後漲跌幅、目標價演進。
 */

import { NextRequest } from 'next/server';
import { apiError, apiOk } from '@/lib/api/response';
import { listReportDates } from '@/lib/broker/brokerStorage';
import { computeBrokerPerformance, type BrokerStockPerformance } from '@/lib/broker/brokerPerformance';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ code: string }> },
) {
  const { code } = await params;
  const pureCode = code.replace(/\.(TW|TWO)$/i, '');
  if (!/^\d{3,6}$/.test(pureCode)) {
    return apiError('code must be 3-6 digits', 400);
  }
  try {
    const dates = await listReportDates();
    const timeline: BrokerStockPerformance[] = [];
    let name = pureCode;
    for (const date of dates) {
      const day = await computeBrokerPerformance(date);
      for (const it of day.items) {
        if (it.stock_code === pureCode) {
          timeline.push(it);
          if (it.stock_name) name = it.stock_name;
        }
      }
    }
    timeline.sort((a, b) => (a.report_date < b.report_date ? 1 : -1));
    return apiOk({ code: pureCode, name, count: timeline.length, timeline });
  } catch (err) {
    return apiError(`broker stock timeline failed: ${(err as Error).message}`, 500);
  }
}
