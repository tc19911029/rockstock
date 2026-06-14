/**
 * GET /api/backtest/leaderboard?market=TW|CN
 *
 * 讀 harness 產出的統一排行榜 JSON，依 market 過濾後回傳（client 端再做引擎/排序/門檻篩選）。
 * 檔案尚未產生 → 回 { exists:false }（不 404，讓頁面渲染空狀態）。
 */

import { NextRequest } from 'next/server';
import { apiOk, apiError } from '@/lib/api/response';
import { loadLeaderboard } from '@/lib/backtest/leaderboardStorage';
import {
  buildEdgeIndex, rowRating, familyRating,
  HONEST_EDGE_DISCLAIMER, type EdgeGrade,
} from '@/lib/strategy/edgeRating';
import { loadHonestEdge } from '@/lib/strategy/edgeRatingStorage';

export const runtime = 'nodejs';

/** 緊湊的每列誠實 edge（route 回給前端、避免再傳整份 doc）。 */
interface RowEdge {
  grade: EdgeGrade;
  familyGrade: EdgeGrade;
  netEdgeD5: number;   // 扣成本後 d5 淨超額（top1）
  excessD5: number;    // 比大盤超額（未扣成本）
  note: string;
}

export async function GET(req: NextRequest) {
  const marketParam = (req.nextUrl.searchParams.get('market') ?? 'TW').toUpperCase();
  if (marketParam !== 'TW' && marketParam !== 'CN') {
    return apiError(`invalid market: ${marketParam}`, 400);
  }
  const market = marketParam as 'TW' | 'CN';

  try {
    const doc = await loadLeaderboard();
    if (!doc) {
      return apiOk({
        market,
        exists: false,
        generatedAt: null,
        rows: [],
        message: 'leaderboard not generated yet — run scripts/backtest-unified-leaderboard.ts',
      });
    }
    const rows = doc.rows.filter((r) => r.market === market);
    // 各市場視窗不同（台股/陸股交易日曆不同）→ 回該市場真實視窗，沒有才退回合併視窗。
    const pm = doc.perMarketWindow?.[market];
    const window = pm
      ? { ...pm, label: doc.window.label, forwardTd: doc.window.forwardTd }
      : doc.window;

    // 誠實 edge 疊加（A1）：每列附「扣成本後比大盤」的淨 edge + 評級；查不到不阻斷。
    const edgeDoc = await loadHonestEdge();
    const edgeIdx = edgeDoc ? buildEdgeIndex(edgeDoc) : null;
    const edgeByRowId: Record<string, RowEdge> = {};
    if (edgeIdx) {
      for (const r of rows) {
        const er = rowRating(edgeIdx, r.id);
        if (!er) continue;
        const fam = familyRating(edgeIdx, market, r.strategyId);
        edgeByRowId[r.id] = {
          grade: er.grade,
          familyGrade: fam?.grade ?? er.grade,
          netEdgeD5: er.netEdge.top1D5,
          excessD5: er.excess.top1D5,
          note: er.honestNote,
        };
      }
    }
    const honestEdge = edgeDoc
      ? {
          disclaimer: HONEST_EDGE_DISCLAIMER,
          generatedAt: edgeDoc.generatedAt,
          method: edgeDoc.method,
          indexAvgD5: edgeDoc.indexAvgForwardPct?.[market]?.d5 ?? null,
          costRoundTripPct: edgeDoc.costRoundTripPct?.[market] ?? null,
          familyKeepCount: edgeDoc.familyCounts?.keep ?? 0,
          caveats: edgeDoc.caveats ?? [],
        }
      : null;

    return apiOk({
      market,
      exists: true,
      generatedAt: doc.generatedAt,
      entryBaseline: doc.entryBaseline,
      window,
      horizons: doc.horizons,
      meta: doc.meta,
      rows,
      edgeByRowId,
      honestEdge,
    });
  } catch (err) {
    return apiError(String(err));
  }
}
