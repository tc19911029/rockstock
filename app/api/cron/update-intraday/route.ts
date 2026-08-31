// GET /api/cron/update-intraday — 盤中 L2 快照刷新（只做刷新，不掃描）
//
// 由本地中央排程每分鐘觸發
// - 將全市場即時報價寫入 Layer 2 快照（單一 JSON 檔）
// - L4 掃描改由 scan-intraday route 獨立觸發，避免 route 時間爆掉

import { NextRequest } from 'next/server';
import { apiOk, apiError } from '@/lib/api/response';
import { checkCronAuth } from '@/lib/api/cronAuth';
import { refreshIntradaySnapshot, getLastRefreshSummary } from '@/lib/datasource/IntradayCache';
import { isMarketOpen, isPostCloseWindow, getCurrentTradingDay } from '@/lib/datasource/marketHours';
import { isTradingDay } from '@/lib/utils/tradingDay';
import { assessIntradayFreshness } from '@/lib/datasource/intradayFreshness';

export const runtime = 'nodejs';
export const maxDuration = 30; // L2 刷新只需 < 10s

export async function GET(req: NextRequest) {
  // Verify Vercel cron secret
  const authDenied = checkCronAuth(req);
  if (authDenied) return authDenied;

  const market = (req.nextUrl.searchParams.get('market') ?? 'TW') as 'TW' | 'CN';
  const force = req.nextUrl.searchParams.get('force') === '1';

  // TW 收盤後只走官方日線，不再打 MIS；CN 暫時保留既有盤後窗口。
  // ?force=1 只留給人工診斷，不是正常排程路徑。
  const pollingWindow = market === 'TW'
    ? isMarketOpen('TW')
    : isMarketOpen('CN') || isPostCloseWindow('CN');
  if (!force && !pollingWindow) {
    return apiOk({ skipped: true, reason: `${market} 非 L2 輪詢時段`, market });
  }

  try {
    // 一輪只抓一次；失敗沿用既有快照，下一個分鐘排程再試，避免 10s/30s 內部重試放大流量。
    const snapshot = await refreshIntradaySnapshot(market, { retryOnEmpty: false });
    const date = getCurrentTradingDay(market);
    const summary = getLastRefreshSummary(market);
    const freshness = assessIntradayFreshness(market, snapshot);

    if (snapshot.count === 0 && isTradingDay(date, market)) {
      console.error(
        `[cron/update-intraday] ★★ ${market} L2 刷新為空！` +
        `連續空 ${summary.consecutiveEmptyCount} 次，告警: ${summary.alertLevel}`
      );
      return apiOk({
        market,
        date: snapshot.date,
        count: 0,
        updatedAt: snapshot.updatedAt,
        alert: true,
        alertLevel: summary.alertLevel,
        warning: `交易日 ${date} 所有數據源失敗`,
        dataSourceStatus: summary.sources,
      });
    }

    if (freshness.stale && isTradingDay(date, market)) {
      console.error(`[cron/update-intraday] ★★ ${market} L2 快照過期：${freshness.reason}`);
      return apiOk({
        market,
        date: snapshot.date,
        count: snapshot.count,
        updatedAt: snapshot.updatedAt,
        alert: true,
        alertLevel: 'critical',
        warning: freshness.reason,
        dataSourceStatus: summary.sources,
      });
    }

    return apiOk({
      market,
      date: snapshot.date,
      count: snapshot.count,
      updatedAt: snapshot.updatedAt,
      dataSourceStatus: summary.sources,
      alertLevel: summary.alertLevel,
    });
  } catch (err) {
    console.error(`[cron/update-intraday] ${market} error:`, err);
    return apiError(`${market} 盤中快照更新失敗: ${String(err)}`);
  }
}
