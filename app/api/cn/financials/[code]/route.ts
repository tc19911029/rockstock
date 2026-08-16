import { apiOk, apiError } from '@/lib/api/response';
import { fetchCnFinancials } from '@/lib/datasource/EastMoneyFinancials';
import { getEastMoneyFundamentals } from '@/lib/datasource/EastMoneyFundamentals';
import { buildCumulativeQuarterTrends, type FundamentalTrendHistory } from '@/lib/fundamentals/trends';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// 陸股基本面：逐季財報（营收/净利/ROE/毛利+YoY，EastMoney→新浪AkShare fallback）+ 估值（PE/PB）。
export async function GET(_req: Request, { params }: { params: Promise<{ code: string }> }) {
  const { code: raw } = await params;
  const code = raw.replace(/\.(SS|SZ)$/i, '');
  if (!/^\d{6}$/.test(code)) return apiError('代號格式錯誤', 400);
  try {
    const [financials, valuation] = await Promise.all([
      fetchCnFinancials(code, 12),
      getEastMoneyFundamentals(code),
    ]);
    const history: FundamentalTrendHistory = {
      market: 'CN',
      monthlyDisclosure: 'not-disclosed',
      monthly: [],
      quarterly: buildCumulativeQuarterTrends(financials.map(row => ({
        period: row.reportDate,
        revenue: row.revenue,
        netIncome: row.netProfit,
        eps: row.eps,
        grossMargin: row.grossMargin,
      }))),
      quarterBasis: 'derived-from-cumulative',
      sourceLabel: 'EastMoney（失敗時切換新浪 AkShare）',
      sourceUrl: 'https://data.eastmoney.com/',
    };
    return apiOk({ code, financials, history, valuation });
  } catch (e) {
    return apiError(e instanceof Error ? e.message : '抓取失敗', 500);
  }
}
