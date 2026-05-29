import { apiOk, apiError } from '@/lib/api/response';
import { getMarketRegime } from '@/lib/cn-sanse/marketRegime';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// 大盤 regime 燈號：GET /api/cn-sanse/regime?date=YYYY-MM-DD（不給 → 最新一日）
export async function GET(req: Request) {
  const date = new URL(req.url).searchParams.get('date') || undefined;
  try {
    const r = await getMarketRegime(date);
    if (!r) return apiError('無上證指數本地K線或歷史不足 60 根', 404);
    return apiOk(r);
  } catch (e) {
    return apiError(e instanceof Error ? e.message : 'regime 計算失敗', 500);
  }
}
