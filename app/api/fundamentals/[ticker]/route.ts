import { NextRequest } from 'next/server';
import { z } from 'zod';
import { getMonthlyRevenue } from '@/lib/datasource/FinMindClient';
import { getFundamentalsWithFallback } from '@/lib/datasource/FundamentalsFallbackChain';
import { apiOk, apiError, apiValidationError } from '@/lib/api/response';
import { isIndexSymbol } from '@/lib/utils/symbols';
import { getMonthlyAny, getQuarterlyAny } from '@/lib/datasource/TwseOpenApiProvider';

const querySchema = z.object({
  mode: z.enum(['full', 'revenue']).default('full'),
  months: z.string().optional(),
  /** debug 用：是否回傳各源 attempt 細節 */
  debug: z.enum(['0', '1']).default('0'),
});

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ ticker: string }> },
) {
  const { ticker } = await params;
  if (isIndexSymbol(ticker)) return apiError('指數無基本面資料', 400);
  const stockId = ticker.replace(/\.(TW|TWO)$/i, '');
  const parsed = querySchema.safeParse(Object.fromEntries(new URL(req.url).searchParams));
  if (!parsed.success) return apiValidationError(parsed.error);
  const { mode, debug } = parsed.data;

  try {
    if (mode === 'revenue') {
      const months = Math.min(24, Math.max(1, parseInt(parsed.data.months ?? '13')));
      const data = await getMonthlyRevenue(stockId, months);
      return apiOk({ data });
    }
    // 多源 fallback：FinMind 失敗自動換 TWSE
    const [result, officialQuarter, officialMonth] = await Promise.all([
      getFundamentalsWithFallback(stockId),
      getQuarterlyAny(stockId),
      getMonthlyAny(stockId),
    ]);
    const { sourceUsed, sourceAttempts, ...data } = result;
    const officialFinancialReportDate = officialQuarter && officialQuarter.rocYear > 0 && officialQuarter.season >= 1
      ? `${officialQuarter.rocYear + 1911}-${String(officialQuarter.season * 3).padStart(2, '0')}-${officialQuarter.season === 1 || officialQuarter.season === 4 ? '31' : '30'}`
      : null;
    const finmindFinancialReportDate = data.periods?.financialReportDate ?? null;
    const useOfficialQuarter = Boolean(
      officialFinancialReportDate
      && (!finmindFinancialReportDate || officialFinancialReportDate >= finmindFinancialReportDate),
    );
    const financialReportDate = useOfficialQuarter ? officialFinancialReportDate : finmindFinancialReportDate;
    const revenueYearMonth = officialMonth?.yearMonth.match(/^(\d{3})(\d{2})$/);
    const officialRevenueMonth = revenueYearMonth
      ? `${Number(revenueYearMonth[1]) + 1911}-${revenueYearMonth[2]}-01`
      : null;
    const finmindRevenueMonth = data.periods?.revenueMonth ?? null;
    const useOfficialMonth = Boolean(
      officialRevenueMonth
      && (!finmindRevenueMonth || officialRevenueMonth >= finmindRevenueMonth),
    );
    const revenueMonth = useOfficialMonth ? officialRevenueMonth : finmindRevenueMonth;
    const enrichedData = {
      ...data,
      ...(useOfficialMonth && officialMonth ? {
        revenueLatest: officialMonth.revenue == null ? data.revenueLatest : officialMonth.revenue * 1000,
        revenueMoM: officialMonth.revenueMoM ?? data.revenueMoM,
        revenueYoY: officialMonth.revenueYoY ?? data.revenueYoY,
      } : {}),
      epsYtd: useOfficialQuarter ? officialQuarter?.eps ?? null : null,
      periods: {
        ...data.periods,
        financialReportDate,
        revenueMonth,
      },
    };
    return apiOk(
      debug === '1'
        ? { data: enrichedData, sourceUsed, sourceAttempts }
        : { data: enrichedData, sourceUsed },
    );
  } catch (e) {
    return apiError((e as Error).message);
  }
}
