/**
 * GET /api/backtest/leaderboard?market=TW|CN
 *
 * 讀 harness 產出的統一排行榜 JSON，依 market 過濾後回傳（client 端再做引擎/排序/門檻篩選）。
 * 檔案尚未產生 → 回 { exists:false }（不 404，讓頁面渲染空狀態）。
 */

import { NextRequest } from 'next/server';
import { apiOk, apiError } from '@/lib/api/response';
import { loadLeaderboard } from '@/lib/backtest/leaderboardStorage';

export const runtime = 'nodejs';

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
    return apiOk({
      market,
      exists: true,
      generatedAt: doc.generatedAt,
      entryBaseline: doc.entryBaseline,
      window: doc.window,
      horizons: doc.horizons,
      meta: doc.meta,
      rows,
    });
  } catch (err) {
    return apiError(String(err));
  }
}
