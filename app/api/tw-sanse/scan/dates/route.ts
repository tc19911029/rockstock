import { apiOk, apiError } from '@/lib/api/response';
import { listTwSanSeDates } from '@/lib/tw-sanse/scanStorage';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// 日期 chip 列：回所有已固化掃描日期（新到舊）+ 各嚴格度命中數。
export async function GET() {
  try {
    const dates = await listTwSanSeDates();
    return apiOk({ dates });
  } catch (e) {
    return apiError(e instanceof Error ? e.message : '讀取失敗', 500);
  }
}
