import { apiOk, apiError } from '@/lib/api/response';
import { fetchShareholderCount } from '@/lib/datasource/EastMoneyShareholderCount';
import { fetchDragonTiger } from '@/lib/datasource/EastMoneyDragonTiger';
import { fetchCapitalFlow, fetchTodayCapitalFlow, fetchTodayMainBuySell } from '@/lib/datasource/EastMoneyCapitalFlow';
import { fetchCnMarginHistory } from '@/lib/cn-agents/datasource/emMarginBalance';
import { computeCnMarginPressure } from '@/lib/chipcost/cnMarginPressure';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// 陸股籌碼面：股东户数（散戶集中度，對標台股集保）+ 龙虎榜（陸股獨有）
//            + 主力資金流向（超大單=主買）+ 兩融（融資融券餘額）。
export async function GET(_req: Request, { params }: { params: Promise<{ code: string }> }) {
  const { code: raw } = await params;
  const code = raw.replace(/\.(SS|SZ)$/i, '');
  if (!/^\d{6}$/.test(code)) return apiError('代號格式錯誤', 400);
  try {
    // 各源獨立 try（allSettled）：某源掛掉不拖垮整個面板
    const [shRes, lhbRes, cfRes, cfTodayRes, mbsRes, mgRes, mpRes] = await Promise.allSettled([
      fetchShareholderCount(code, 8),
      fetchDragonTiger(code, 8),
      fetchCapitalFlow(code, 10),            // toSecid 以首碼猜交易所（6→滬、3/0→深）
      fetchTodayCapitalFlow(code),           // 盤中即時今日累計（分鐘端點，淨額+超大/大單）
      fetchTodayMainBuySell(code),           // 今日主買/主賣毛額（主力流入/流出）
      fetchCnMarginHistory(code, 10),
      // 融資成本回推 + 平倉/警戒壓力價（估算，純顯示層，不進選股 gate）
      computeCnMarginPressure(raw),
    ]);
    const val = <T>(r: PromiseSettledResult<T>, dflt: T): T => (r.status === 'fulfilled' ? r.value : dflt);
    return apiOk({
      code,
      shareholders: val(shRes, []),
      dragontiger: val(lhbRes, []),
      capitalFlow: val(cfRes, []),
      capitalFlowToday: val(cfTodayRes, null),
      mainBuySell: val(mbsRes, null),
      margin: val(mgRes, []),
      marginPressure: val(mpRes, null),
    });
  } catch (e) {
    return apiError(e instanceof Error ? e.message : '抓取失敗', 500);
  }
}
