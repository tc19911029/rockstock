// instrumentation.ts — Next.js server startup hook
// 本地開發時自動定期刷新 L2 盤中快照 + 掃描存 L4（模擬 Vercel Cron）

export async function register() {
  // 只在本地開發啟動定時器（Vercel 有自己的 cron）
  if (process.env.VERCEL || process.env.NODE_ENV === 'test') return;

  // 動態 import 避免影響 build
  const { refreshIntradaySnapshot } = await import('./lib/datasource/IntradayCache');
  const { isMarketOpen, isPostCloseWindow, getCurrentTradingDay } = await import('./lib/datasource/marketHours');
  const { saveScanSession } = await import('./lib/storage/scanStorage');

  console.log('[local-cron] 本地開發模式，啟動 L2 快照刷新 + L4 盤中掃描');
  console.log('[local-cron] TW: 每 5 分鐘 / CN: 每 2 分鐘（盤中+盤後窗口）');

  // 共用的掃描邏輯：L2 刷新後立即跑 long-daily 掃描存 L4
  async function refreshAndScan(market: 'TW' | 'CN') {
    // 盤中 或 盤後窗口（收盤後30分鐘）都允許刷新
    if (!isMarketOpen(market) && !isPostCloseWindow(market)) return;

    // Phase 1: 刷新 L2 快照
    const snap = await refreshIntradaySnapshot(market);
    console.log(`[local-cron] ${market} L2 已刷新: ${snap.count} 支, ${snap.updatedAt}`);

    // L2 為空時跳過掃描，避免用過時數據產生誤導結果
    if (snap.count === 0) {
      console.warn(`[local-cron] ${market} L2 快照為空，跳過本輪掃描`);
      return;
    }

    // Phase 2: 從 L2 快照建立即時報價 Map，讓 scanner 合併今日 K 棒
    const realtimeQuotes = new Map<string, { open: number; high: number; low: number; close: number; volume: number; date?: string }>();
    for (const q of snap.quotes) {
      const code = q.symbol.replace(/\.(TW|TWO|SS|SZ)$/i, '');
      if (q.close > 0) {
        realtimeQuotes.set(code, {
          open: q.open, high: q.high, low: q.low,
          close: q.close, volume: q.volume,
          date: snap.date, // L2 快照日期 = 今天
        });
      }
    }
    console.log(`[local-cron] ${market} 即時報價 Map: ${realtimeQuotes.size} 支`);

    // Phase 3: 盤中掃描存 L4
    const date = getCurrentTradingDay(market);
    try {
      if (market === 'TW') {
        const { TaiwanScanner } = await import('./lib/scanner/TaiwanScanner');
        const scanner = new TaiwanScanner();
        scanner.setRealtimeQuotes(realtimeQuotes);
        const stocks = await scanner.getStockList();
        const { results, sessionFreshness } = await scanner.scanSOP(stocks, date);
        await saveScanSession({
          id: `TW-long-daily-${date}-intraday-${Date.now()}`,
          market: 'TW', date, direction: 'long',
          multiTimeframeEnabled: false,
          sessionType: 'intraday',
          scanTime: new Date().toISOString(),
          resultCount: results.length,
          results,
          dataFreshness: sessionFreshness,
        });
        console.log(`[local-cron] TW L4 掃描完成: ${results.length} 檔, 日期 ${date}`);
      } else {
        const { ChinaScanner } = await import('./lib/scanner/ChinaScanner');
        const scanner = new ChinaScanner();
        scanner.setRealtimeQuotes(realtimeQuotes);
        const stocks = await scanner.getStockList();
        const { results, sessionFreshness } = await scanner.scanSOP(stocks, date);
        await saveScanSession({
          id: `CN-long-daily-${date}-intraday-${Date.now()}`,
          market: 'CN', date, direction: 'long',
          multiTimeframeEnabled: false,
          sessionType: 'intraday',
          scanTime: new Date().toISOString(),
          resultCount: results.length,
          results,
          dataFreshness: sessionFreshness,
        });
        console.log(`[local-cron] CN L4 掃描完成: ${results.length} 檔, 日期 ${date}`);
      }
    } catch (scanErr) {
      console.error(`[local-cron] ${market} 掃描失敗 (non-fatal):`, scanErr);
    }
  }

  // TW: 每 5 分鐘
  setInterval(async () => {
    try { await refreshAndScan('TW'); }
    catch (err) { console.error('[local-cron] TW 刷新+掃描失敗:', err); }
  }, 5 * 60 * 1000);

  // CN: 每 2 分鐘
  setInterval(async () => {
    try { await refreshAndScan('CN'); }
    catch (err) { console.error('[local-cron] CN 刷新+掃描失敗:', err); }
  }, 2 * 60 * 1000);
}
