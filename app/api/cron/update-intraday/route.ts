// GET /api/cron/update-intraday — 盤中即時快照自動更新
//
// 由 Vercel Cron 每 2 分鐘觸發（盤中時段）
// 將全市場即時報價寫入 Layer 2 快照（單一 JSON 檔）
// 粗掃（/api/scanner/coarse）讀此快照進行篩選

import { NextRequest } from 'next/server';
import { apiOk, apiError } from '@/lib/api/response';
import { refreshIntradaySnapshot } from '@/lib/datasource/IntradayCache';
import { isMarketOpen } from '@/lib/datasource/marketHours';

export const runtime = 'nodejs';
export const maxDuration = 30;

export async function GET(req: NextRequest) {
  // Verify Vercel cron secret
  const authHeader = req.headers.get('authorization');
  if (process.env.CRON_SECRET && authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return apiError('Unauthorized', 401);
  }

  const market = (req.nextUrl.searchParams.get('market') ?? 'TW') as 'TW' | 'CN';

  // 只在盤中更新
  if (!isMarketOpen(market)) {
    return apiOk({ skipped: true, reason: `${market} 非開盤時段`, market });
  }

  try {
    const snapshot = await refreshIntradaySnapshot(market);
    return apiOk({
      market,
      date: snapshot.date,
      count: snapshot.count,
      updatedAt: snapshot.updatedAt,
    });
  } catch (err) {
    console.error(`[cron/update-intraday] ${market} error:`, err);
    return apiError(`${market} 盤中快照更新失敗: ${String(err)}`);
  }
}
