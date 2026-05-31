import { apiOk, apiError } from '@/lib/api/response';
import { fetchShareholderCount } from '@/lib/datasource/EastMoneyShareholderCount';
import { fetchDragonTiger } from '@/lib/datasource/EastMoneyDragonTiger';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// 陸股籌碼面：股东户数（散戶集中度，對標台股集保）+ 龙虎榜（陸股獨有）。
export async function GET(_req: Request, { params }: { params: Promise<{ code: string }> }) {
  const { code: raw } = await params;
  const code = raw.replace(/\.(SS|SZ)$/i, '');
  if (!/^\d{6}$/.test(code)) return apiError('代號格式錯誤', 400);
  try {
    const [shareholders, dragontiger] = await Promise.all([
      fetchShareholderCount(code, 8),
      fetchDragonTiger(code, 8),
    ]);
    return apiOk({ code, shareholders, dragontiger });
  } catch (e) {
    return apiError(e instanceof Error ? e.message : '抓取失敗', 500);
  }
}
