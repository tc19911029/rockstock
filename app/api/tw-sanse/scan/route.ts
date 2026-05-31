import { apiOk, apiError } from '@/lib/api/response';
import { scanTwSanSe } from '@/lib/tw-sanse/scan';
import { loadTwSanSeScan, saveTwSanSeScan, latestTwSanSeDate } from '@/lib/tw-sanse/scanStorage';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300; // 全市場掃 ~1900 檔；避免 Vercel 預設 10s 逾時

// 台股三色資金掃描。讀固化結果為主；?force=1 即時重掃並固化當日；?date= 指定回看某日。
// v1 無盤中即時（台股三色盤中為後續增強），?session=intraday 一律當盤後處理。
export async function GET(req: Request) {
  const url = new URL(req.url);
  const force = url.searchParams.get('force') === '1';
  const date = url.searchParams.get('date');

  try {
    // 指定日期 → 只讀固化
    if (date) {
      const r = await loadTwSanSeScan(date);
      if (!r) return apiError(`${date} 無固化掃描結果`, 404);
      return apiOk({ ...r, cached: true });
    }

    // 即時重掃並固化
    if (force) {
      const result = await scanTwSanSe();
      await saveTwSanSeScan(result);
      return apiOk({ ...result, cached: false });
    }

    // 預設：讀最新一日固化；沒有就跑一次並固化
    const latest = await latestTwSanSeDate();
    if (latest) {
      const r = await loadTwSanSeScan(latest);
      if (r) return apiOk({ ...r, cached: true });
    }
    const result = await scanTwSanSe();
    await saveTwSanSeScan(result);
    return apiOk({ ...result, cached: false });
  } catch (e) {
    return apiError(e instanceof Error ? e.message : '掃描失敗', 500);
  }
}
