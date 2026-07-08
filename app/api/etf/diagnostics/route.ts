/**
 * GET /api/etf/diagnostics?topN=10&minOverlap=40
 *
 * ETF 體檢（課程 CH12 誤區三）：讀台股型主動 ETF 最新持股快照，計算
 *   - 成分股集中榜（哪些個股被最多 ETF 前 N 大同時持有）
 *   - 高重疊 ETF 配對（前 N 大重疊度）
 *
 * 純顯示／教學層，資料全部來自現有持股快照，不打新資料源。
 */
import { NextRequest } from 'next/server';
import { apiOk, apiError } from '@/lib/api/response';
import { ACTIVE_ETF_LIST, isGlobalETF } from '@/lib/etf/etfList';
import { loadLatestETFSnapshot } from '@/lib/etf/etfStorage';
import {
  computeSharedHoldings,
  computeOverlapPairs,
  type ETFHoldingsInput,
} from '@/lib/etf/ch12Diagnostics';

export const runtime = 'nodejs';

export async function GET(req: NextRequest) {
  try {
    const topNParam = Number(req.nextUrl.searchParams.get('topN') ?? '10');
    const topN = Number.isFinite(topNParam) && topNParam >= 3 && topNParam <= 30 ? topNParam : 10;
    const minOverlapParam = Number(req.nextUrl.searchParams.get('minOverlap') ?? '40');
    const minOverlap = Number.isFinite(minOverlapParam) ? Math.max(0, minOverlapParam) : 40;

    // 只看台股型主動 ETF（全球／美國型持股與台股無關，重疊度沒有意義）
    const codes = ACTIVE_ETF_LIST.filter((e) => !isGlobalETF(e.etfCode)).map((e) => e.etfCode);

    const inputs: ETFHoldingsInput[] = [];
    let latestDate: string | null = null;
    for (const code of codes) {
      const snap = await loadLatestETFSnapshot(code);
      if (!snap || snap.holdings.length === 0 || snap.source === 'stub') continue;
      inputs.push({
        etfCode: snap.etfCode,
        etfName: snap.etfName,
        holdings: snap.holdings,
        disclosureDate: snap.disclosureDate,
      });
      if (!latestDate || snap.disclosureDate > latestDate) latestDate = snap.disclosureDate;
    }

    if (inputs.length < 2) {
      return apiOk({
        asOfDate: latestDate,
        etfCount: inputs.length,
        topN,
        sharedHoldings: [],
        overlapPairs: [],
        note: '可用 ETF 持股快照不足（需至少 2 檔），無法計算重疊度。',
      });
    }

    const sharedHoldings = computeSharedHoldings(inputs, topN)
      .filter((s) => s.count >= 2) // 只列被 ≥2 檔持有的（單一持有無集中意義）
      .slice(0, 25);
    const overlapPairs = computeOverlapPairs(inputs, topN, minOverlap).slice(0, 30);

    return apiOk({
      asOfDate: latestDate,
      etfCount: inputs.length,
      topN,
      sharedHoldings,
      overlapPairs,
    });
  } catch (err) {
    console.error('[etf/diagnostics] error:', err);
    return apiError('ETF 體檢查詢暫時無法使用');
  }
}
