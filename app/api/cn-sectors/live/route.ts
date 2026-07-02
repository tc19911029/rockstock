/**
 * 陸股盤中即時板塊（行業 + 概念）
 * GET /api/cn-sectors/live
 *
 * 盤中/盤後窗口 → 直接打東財 push2 clist 即時板塊行情（fetchBoardSnapshot，含主站/鏡像
 * host failover + curl fallback），排名即時跳動。收盤或抓取全失敗 → 退回最後一日存檔
 * （buildLatestCnBoardRanking），標 stale=true。概念排行濾掉風格/大盤/寬基指數大指數
 * （filterRealConcepts，對齊東財 App）。純顯示層、不參與選股（鐵則 #5）。記憶體快取 40s。
 */
import { NextRequest } from 'next/server';
import { apiOk, apiError } from '@/lib/api/response';
import { globalCache } from '@/lib/datasource/MemoryCache';
import { isMarketOpen, isPostCloseWindow } from '@/lib/datasource/marketHours';
import { fetchBoardSnapshot } from '@/lib/cn-agents/datasource/emBoards';
import { filterThemeConcepts, isBehavioralBoard, classifyBoardStage, buildLatestCnBoardRanking } from '@/lib/cn-agents/boardRanking';
import type { BoardEntry } from '@/lib/cn-agents/types';

export const runtime = 'nodejs';
export const maxDuration = 30;

const CACHE_TTL = 40 * 1000;

interface LiveBoard extends BoardEntry {
  stage: string;
}
interface CnLivePayload {
  marketOpen: boolean;
  stale: boolean;
  updatedAt: string;
  date: string | null;
  industries: LiveBoard[];
  concepts: LiveBoard[];
}

const withStage = (arr: BoardEntry[]): LiveBoard[] =>
  arr.map((b) => ({ ...b, stage: classifyBoardStage(b) }));

export async function GET(_req: NextRequest) {
  const open = isMarketOpen('CN');
  const liveWindow = open || isPostCloseWindow('CN');
  const cacheKey = `live-cn-sectors:${liveWindow ? 'live' : 'stale'}`;
  const cached = globalCache.get<CnLivePayload>(cacheKey);
  if (cached) return apiOk(cached);

  // 盤中/盤後窗口：即時抓東財板塊
  if (liveWindow) {
    try {
      const [ind, con] = await Promise.all([
        fetchBoardSnapshot('industry'),
        fetchBoardSnapshot('concept'),
      ]);
      const payload: CnLivePayload = {
        marketOpen: open,
        stale: false,
        updatedAt: new Date().toISOString(),
        date: null,
        industries: withStage(ind.entries),
        concepts: withStage(filterThemeConcepts(con.entries)),
      };
      globalCache.set(cacheKey, payload, CACHE_TTL);
      return apiOk(payload);
    } catch {
      // 東財連鏡像都掛 → 落到最後存檔，不丟 500
    }
  }

  // 收盤 / 即時抓取失敗 → 最後一日存檔
  const file = await buildLatestCnBoardRanking();
  if (!file) return apiError('no CN board snapshot available', 404);
  const payload: CnLivePayload = {
    marketOpen: open,
    stale: true,
    updatedAt: file.generatedAt,
    date: file.date,
    industries: file.industries.map((b) => ({ ...b, stage: b.stage })),
    // 純題材：存檔的 concepts 已過 filterRealConcepts，這裡再濾盤口/行為/財務/指數型
    concepts: file.concepts.filter((b) => !isBehavioralBoard(b)).map((b) => ({ ...b, stage: b.stage })),
  };
  globalCache.set(cacheKey, payload, CACHE_TTL);
  return apiOk(payload);
}
