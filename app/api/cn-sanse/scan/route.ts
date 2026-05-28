import { apiOk, apiError } from '@/lib/api/response';
import { scanSanSe } from '@/lib/cn-sanse/scan';
import { loadSanSeScan, saveSanSeScan, latestSanSeDate } from '@/lib/cn-sanse/scanStorage';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// 讀固化結果為主；?force=1 即時重掃並固化當日；?date= 指定回看某日。
export async function GET(req: Request) {
  const url = new URL(req.url);
  const force = url.searchParams.get('force') === '1';
  const date = url.searchParams.get('date');

  try {
    // 指定日期 → 只讀固化
    if (date) {
      const r = await loadSanSeScan(date);
      if (!r) return apiError(`${date} 無固化掃描結果`, 404);
      return apiOk({ ...r, cached: true });
    }

    // 即時重掃並固化
    if (force) {
      const result = await scanSanSe();
      await saveSanSeScan(result);
      return apiOk({ ...result, cached: false });
    }

    // 預設：讀最新一日固化；沒有就跑一次並固化
    const latest = await latestSanSeDate();
    if (latest) {
      const r = await loadSanSeScan(latest);
      if (r) return apiOk({ ...r, cached: true });
    }
    const result = await scanSanSe();
    await saveSanSeScan(result);
    return apiOk({ ...result, cached: false });
  } catch (e) {
    return apiError(e instanceof Error ? e.message : '掃描失敗', 500);
  }
}
