import { apiOk, apiError } from '@/lib/api/response';
import { fetchCnFinancials } from '@/lib/datasource/EastMoneyFinancials';
import { getEastMoneyFundamentals } from '@/lib/datasource/EastMoneyFundamentals';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// 陸股基本面：逐季財報（营收/净利/ROE/毛利+YoY，EastMoney→新浪AkShare fallback）+ 估值（PE/PB）。
export async function GET(_req: Request, { params }: { params: Promise<{ code: string }> }) {
  const { code: raw } = await params;
  const code = raw.replace(/\.(SS|SZ)$/i, '');
  if (!/^\d{6}$/.test(code)) return apiError('代號格式錯誤', 400);
  try {
    const [financials, valuation] = await Promise.all([
      fetchCnFinancials(code, 8),
      getEastMoneyFundamentals(code),
    ]);
    return apiOk({ code, financials, valuation });
  } catch (e) {
    return apiError(e instanceof Error ? e.message : '抓取失敗', 500);
  }
}
