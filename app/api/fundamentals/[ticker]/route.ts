import { NextRequest } from 'next/server';
import { z } from 'zod';
import { getMonthlyRevenue, getQuarterlyHistory, getSharesIssued } from '@/lib/datasource/FinMindClient';
import { getFundamentalsWithFallback } from '@/lib/datasource/FundamentalsFallbackChain';
import { apiOk, apiError, apiValidationError } from '@/lib/api/response';
import { isIndexSymbol } from '@/lib/utils/symbols';
import { getMonthlyAny, getQuarterlyAny } from '@/lib/datasource/TwseOpenApiProvider';
import { getTwSelfReportedMonthlyActuals } from '@/lib/datasource/TwSelfReportedEps';
import { dilutionEventSignature, readDilutionEvents } from '@/lib/valuation/corporateActions';
import { loadFundamentalSupplement, mergeSelfReportedActuals } from '@/lib/valuation/supplementalFundamentals';
import { getTwseCompanyFinancials } from '@/lib/datasource/TwseCompanyFinancials';
import {
  buildMonthlyFundamentalTrends,
  buildSingleQuarterTrends,
  type FundamentalTrendHistory,
} from '@/lib/fundamentals/trends';

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
    const [
      result,
      officialQuarter,
      officialMonth,
      fetchedSelfReportedMonthlyActuals,
      sharesOutstanding,
      dilutionEvents,
      supplement,
      history,
    ] = await Promise.all([
      getFundamentalsWithFallback(stockId),
      getQuarterlyAny(stockId),
      getMonthlyAny(stockId),
      getTwSelfReportedMonthlyActuals(stockId).catch(() => []),
      getSharesIssued(stockId).catch(() => null),
      readDilutionEvents(stockId).catch(() => []),
      loadFundamentalSupplement(stockId).catch(() => null),
      loadTwFundamentalHistory(stockId),
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
    const supplementalQuarter = supplement?.quarterlyActuals
      ?.slice()
      .sort((a, b) => b.quarter.localeCompare(a.quarter))[0];
    const baseFinancialReportDate = useOfficialQuarter ? officialFinancialReportDate : finmindFinancialReportDate;
    const financialReportDate = supplementalQuarter?.quarter && (
      !baseFinancialReportDate || supplementalQuarter.quarter >= baseFinancialReportDate
    ) ? supplementalQuarter.quarter : baseFinancialReportDate;
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
    const selfReportedMonthlyActuals = mergeSelfReportedActuals(
      fetchedSelfReportedMonthlyActuals,
      supplement?.selfReportedMonthlyActuals,
    );
    const effectiveShares = supplement?.sharesOutstanding ?? sharesOutstanding;
    const epsYtd = supplement?.latestCumulativeActual?.cumulativeEps
      ?? (useOfficialQuarter ? officialQuarter?.eps ?? null : null);
    const asPercent = (value: number | null | undefined) => value == null
      ? undefined
      : Math.abs(value) <= 1 ? value * 100 : value;
    const enrichedData = {
      ...data,
      ...(supplementalQuarter ? {
        eps: supplementalQuarter.eps ?? data.eps,
        netMargin: asPercent(supplementalQuarter.netMargin) ?? data.netMargin,
        grossMargin: asPercent(supplementalQuarter.grossMargin) ?? data.grossMargin,
      } : {}),
      ...(useOfficialMonth && officialMonth ? {
        revenueLatest: officialMonth.revenue == null ? data.revenueLatest : officialMonth.revenue * 1000,
        revenueMoM: officialMonth.revenueMoM ?? data.revenueMoM,
        revenueYoY: officialMonth.revenueYoY ?? data.revenueYoY,
      } : {}),
      epsYtd,
      selfReportedMonthlyActuals,
      sharesOutstanding: effectiveShares,
      dilutionEvents,
      dilutionSignature: dilutionEventSignature(dilutionEvents),
      history,
      periods: {
        ...data.periods,
        financialReportDate,
        revenueMonth,
        selfReportedPeriod: selfReportedMonthlyActuals[0]?.period ?? null,
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

async function loadTwFundamentalHistory(stockId: string): Promise<FundamentalTrendHistory> {
  const [officialResult, finMindQuarterResult, finMindMonthResult] = await Promise.allSettled([
    getTwseCompanyFinancials(stockId),
    getQuarterlyHistory(stockId, 12),
    getMonthlyRevenue(stockId, 24),
  ]);
  const official = officialResult.status === 'fulfilled' ? officialResult.value : null;
  const finMindQuarters = finMindQuarterResult.status === 'fulfilled' ? finMindQuarterResult.value : [];
  const finMindMonths = finMindMonthResult.status === 'fulfilled' ? finMindMonthResult.value : [];

  // Official rows win. FinMind fills older/missing periods so every displayed row can
  // calculate a matching previous quarter/year where available.
  const quarterByPeriod = new Map(finMindQuarters.map(row => [row.quarter, row]));
  for (const row of official?.quarterly ?? []) {
    const fallback = quarterByPeriod.get(row.quarter);
    quarterByPeriod.set(row.quarter, {
      ...fallback,
      ...row,
      revenue: row.revenue ?? fallback?.revenue ?? null,
      grossProfit: row.grossProfit ?? fallback?.grossProfit ?? null,
      netIncome: row.netIncome ?? fallback?.netIncome ?? null,
      grossMargin: row.grossMargin ?? fallback?.grossMargin ?? null,
      netMargin: row.netMargin ?? fallback?.netMargin ?? null,
    });
  }
  const monthByPeriod = new Map(finMindMonths.map(row => [row.date.slice(0, 7), {
    period: row.date,
    revenue: row.revenue,
  }]));
  for (const row of official?.monthlyRevenue ?? []) {
    monthByPeriod.set(row.month.slice(0, 7), { period: row.month, revenue: row.revenue });
  }

  const sourceLabel = official
    ? finMindQuarters.length || finMindMonths.length
      ? 'TWSE 投資資訊中心＋FinMind 補歷史'
      : 'TWSE 投資資訊中心'
    : finMindQuarters.length || finMindMonths.length
      ? 'FinMind'
      : '目前無可用歷史資料';

  return {
    market: 'TW',
    monthlyDisclosure: 'available',
    monthly: buildMonthlyFundamentalTrends([...monthByPeriod.values()]),
    quarterly: buildSingleQuarterTrends([...quarterByPeriod.values()].map(row => ({
      period: row.quarter,
      revenue: row.revenue,
      netIncome: row.netIncome,
      eps: row.eps,
      grossMargin: row.grossMargin,
      netMargin: row.netMargin,
    }))),
    quarterBasis: 'single-quarter',
    sourceLabel,
    sourceUrl: official?.sourceUrl ?? 'https://data.finmindtrade.com/',
  };
}
