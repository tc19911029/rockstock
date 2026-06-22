/**
 * GET /api/etf/consensus?date=YYYY-MM-DD&minEtfs=2
 *
 * 回傳共識買榜。預設讀最近一日；若無資料就近 5 個交易日合併再算。
 */
import { NextRequest } from 'next/server';
import { apiOk, apiError } from '@/lib/api/response';
import { ACTIVE_ETF_LIST, isGlobalETF } from '@/lib/etf/etfList';
import {
  loadConsensus,
  listConsensusDates,
  loadAllChangesForDate,
  listChangeDates,
} from '@/lib/etf/etfStorage';
import { computeConsensus } from '@/lib/etf/consensusCalc';
import type { ETFChange, ETFConsensusEntry } from '@/lib/etf/types';

export const runtime = 'nodejs';

// 只留台股型 ETF：把全球／美國型 ETF 從每筆共識的 etfCodes 拿掉後重新門檻過濾。
// 只由全球 ETF 撐起的外國股共識 → etfCodes 變空 → 自動消失。
function twOnlyConsensus(entries: ETFConsensusEntry[], minEtfs: number): ETFConsensusEntry[] {
  return entries
    .map((e) => {
      const keep = e.etfCodes
        .map((c, i) => [c, i] as const)
        .filter(([c]) => !isGlobalETF(c));
      return { ...e, etfCodes: keep.map(([c]) => c), etfNames: keep.map(([, i]) => e.etfNames[i]) };
    })
    .filter((e) => e.etfCodes.length >= minEtfs);
}

export async function GET(req: NextRequest) {
  try {
    const dateParam = req.nextUrl.searchParams.get('date');
    const minEtfsParam = Number(req.nextUrl.searchParams.get('minEtfs') ?? '2');
    const minEtfs = Number.isFinite(minEtfsParam) && minEtfsParam >= 1 ? minEtfsParam : 2;

    // 只考慮台股型 ETF（全球／美國型隱藏）
    const allCodes = ACTIVE_ETF_LIST.filter((e) => !isGlobalETF(e.etfCode)).map((e) => e.etfCode);

    // 試讀快取
    if (dateParam) {
      const cached = await loadConsensus(dateParam);
      if (cached) {
        return apiOk({
          date: dateParam,
          windowDays: 1,
          entries: twOnlyConsensus(cached, minEtfs),
        });
      }
    } else {
      const dates = await listConsensusDates();
      for (const d of dates.slice(0, 5)) {
        const cached = await loadConsensus(d);
        if (cached && cached.length > 0) {
          return apiOk({
            date: d,
            windowDays: 1,
            entries: twOnlyConsensus(cached, minEtfs),
          });
        }
      }
    }

    // Fallback：合併最近 5 個交易日的 changes 重算
    const recentDates = new Set<string>();
    for (const code of allCodes) {
      for (const d of (await listChangeDates(code)).slice(0, 5)) recentDates.add(d);
    }
    const sortedRecent = Array.from(recentDates).sort().reverse().slice(0, 5);
    const allChanges: ETFChange[] = [];
    for (const d of sortedRecent) {
      allChanges.push(...(await loadAllChangesForDate(d, allCodes)));
    }

    const computed = computeConsensus(allChanges, minEtfs);
    return apiOk({
      date: sortedRecent[0] ?? null,
      windowDays: sortedRecent.length,
      entries: computed,
    });
  } catch (err) {
    console.error('[etf/consensus] error:', err);
    return apiError('ETF 共識買榜查詢暫時無法使用');
  }
}
