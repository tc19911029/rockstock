// GET /api/cron/update-intraday — 盤中即時快照自動更新 + 掃描
//
// 由 Vercel Cron 每 5 分鐘（TW）/ 2 分鐘（CN）觸發
// 1. 將全市場即時報價寫入 Layer 2 快照（單一 JSON 檔）
// 2. 合併 L1 歷史K線，跑一次 long-daily 掃描策略
// 3. 結果存入 L4（覆蓋同日 post_close，前端免改動）

import { NextRequest } from 'next/server';
import { apiOk, apiError } from '@/lib/api/response';
import { refreshIntradaySnapshot, getLastRefreshSummary } from '@/lib/datasource/IntradayCache';
import { isMarketOpen, getCurrentTradingDay } from '@/lib/datasource/marketHours';
import { isTradingDay } from '@/lib/utils/tradingDay';

export const runtime = 'nodejs';
export const maxDuration = 120; // 提高：L2 刷新 ~5s + 掃描 ~30-60s

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
    // ── Phase 1: 刷新 L2 快照 ──
    let snapshot = await refreshIntradaySnapshot(market);

    // ── Phase 2: 盤中掃描（僅 long-daily，精簡版）──
    const date = getCurrentTradingDay(market);
    let scanCount = -1;

    // L2 為空時：區分「交易日 API 失敗」vs「非交易日正常」
    if (snapshot.count === 0) {
      const refreshSummary = getLastRefreshSummary(market);
      const tradingDayFlag = isTradingDay(date, market);

      if (tradingDayFlag) {
        // ★ 交易日但 L2 為空 → 延遲 15 秒再試一次（IntradayCache 已做 10 秒重試，這是第二道）
        console.error(
          `[cron/update-intraday] ★ ${market} 交易日 ${date} L2 快照為空！` +
          `嘗試 15 秒後二次重試...`
        );
        await new Promise(resolve => setTimeout(resolve, 15_000));
        const retrySnapshot = await refreshIntradaySnapshot(market);
        const retryRefreshSummary = getLastRefreshSummary(market);

        if (retrySnapshot.count > 0) {
          console.info(`[cron/update-intraday] ${market} 二次重試成功: ${retrySnapshot.count} 筆`);
          // 繼續往下走正常掃描流程
          snapshot = retrySnapshot;
        } else {
          console.error(
            `[cron/update-intraday] ★★ ${market} 二次重試仍然 0 筆！` +
            `連續空 ${retryRefreshSummary.consecutiveEmptyCount} 次，告警等級: ${retryRefreshSummary.alertLevel}`
          );
          return apiOk({
            market,
            date: snapshot.date,
            count: 0,
            updatedAt: snapshot.updatedAt,
            scanCount: -1,
            scanDate: date,
            alert: true,
            alertLevel: retryRefreshSummary.alertLevel,
            warning: `交易日 ${date} 所有數據源失敗，非休市！連續空 ${retryRefreshSummary.consecutiveEmptyCount} 次`,
            dataSourceStatus: retryRefreshSummary.sources,
          });
        }
      } else {
        // 非交易日 → 正常跳過
        console.info(`[cron/update-intraday] ${market} ${date} 非交易日，跳過掃描`);
        return apiOk({
          market,
          date: snapshot.date,
          count: 0,
          updatedAt: snapshot.updatedAt,
          scanCount: -1,
          scanDate: date,
          warning: `${date} 非交易日`,
          dataSourceStatus: refreshSummary.sources,
        });
      }
    }

    // ── Phase 2.5: 從 L2 快照建立即時報價 Map，讓 scanner 合併今日 K 棒 ──
    const realtimeQuotes = new Map<string, { open: number; high: number; low: number; close: number; volume: number; date?: string }>();
    for (const q of snapshot.quotes) {
      const code = q.symbol.replace(/\.(TW|TWO|SS|SZ)$/i, '');
      if (q.close > 0) {
        realtimeQuotes.set(code, {
          open: q.open, high: q.high, low: q.low,
          close: q.close, volume: q.volume,
          date: snapshot.date,
        });
      }
    }

    try {
      const { saveScanSession } = await import('@/lib/storage/scanStorage');

      if (market === 'TW') {
        const { TaiwanScanner } = await import('@/lib/scanner/TaiwanScanner');
        const scanner = new TaiwanScanner();
        scanner.setRealtimeQuotes(realtimeQuotes);
        const stocks = await scanner.getStockList();
        const { results, sessionFreshness } = await scanner.scanSOP(stocks, date);

        const session = {
          id: `TW-long-daily-${date}-intraday-${Date.now()}`,
          market: 'TW' as const,
          date,
          direction: 'long' as const,
          multiTimeframeEnabled: false,
          sessionType: 'intraday' as const,
          scanTime: new Date().toISOString(),
          resultCount: results.length,
          results,
          dataFreshness: sessionFreshness,
        };
        await saveScanSession(session);
        scanCount = results.length;
      } else {
        const { ChinaScanner } = await import('@/lib/scanner/ChinaScanner');
        const scanner = new ChinaScanner();
        scanner.setRealtimeQuotes(realtimeQuotes);
        const stocks = await scanner.getStockList();
        const { results, sessionFreshness } = await scanner.scanSOP(stocks, date);

        const session = {
          id: `CN-long-daily-${date}-intraday-${Date.now()}`,
          market: 'CN' as const,
          date,
          direction: 'long' as const,
          multiTimeframeEnabled: false,
          sessionType: 'intraday' as const,
          scanTime: new Date().toISOString(),
          resultCount: results.length,
          results,
          dataFreshness: sessionFreshness,
        };
        await saveScanSession(session);
        scanCount = results.length;
      }
    } catch (scanErr) {
      // 掃描失敗不影響 L2 更新結果
      console.error(`[cron/update-intraday] ${market} 盤中掃描失敗 (non-fatal):`, scanErr);
    }

    const finalSummary = getLastRefreshSummary(market);
    return apiOk({
      market,
      date: snapshot.date,
      count: snapshot.count,
      updatedAt: snapshot.updatedAt,
      scanCount,
      scanDate: date,
      dataSourceStatus: finalSummary.sources,
    });
  } catch (err) {
    console.error(`[cron/update-intraday] ${market} error:`, err);
    return apiError(`${market} 盤中快照更新失敗: ${String(err)}`);
  }
}
