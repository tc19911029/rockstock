import { apiOk, apiError } from '@/lib/api/response';
import { scanTwSanSe } from '@/lib/tw-sanse/scan';
import { loadTwSanSeScan, saveTwSanSeScan, latestTwSanSeDate, loadTwSanSeIntraday, latestTwSanSeIntradayDate } from '@/lib/tw-sanse/scanStorage';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300; // 全市場掃 ~1900 檔；避免 Vercel 預設 10s 逾時

// 台股三色資金掃描。讀固化結果為主；?force=1 即時重掃並固化當日；?date= 指定回看某日；
// ?session=intraday 讀盤中即時快照（與 CN 對齊；盤後 18:35 封存版不受影響）。
export async function GET(req: Request) {
  const url = new URL(req.url);
  const force = url.searchParams.get('force') === '1';
  const date = url.searchParams.get('date');
  const session = url.searchParams.get('session');

  try {
    // 盤中即時：讀 intraday 快照（?date= 指定日，否則最新盤中日）。盤後封存版不受影響。
    if (session === 'intraday') {
      const d = date ?? (await latestTwSanSeIntradayDate());
      if (!d) return apiError('尚無盤中即時快照', 404);
      const r = await loadTwSanSeIntraday(d);
      if (!r) return apiError('尚無盤中即時快照', 404);
      return apiOk({ ...r, cached: true });
    }

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
