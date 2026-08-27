import { BOOK_UNIVERSE_TOP_N } from './universeTopN';
import { assessYTrackReadiness, repairYTrackCurrentData } from '@/lib/chips/yTrackReadiness';

export async function runInstStealTrack(date: string) {
  const { TaiwanScanner } = await import('./TaiwanScanner');
  const { computeTurnoverRankAsOfDate } = await import('./TurnoverRank');
  const { injectForwardPerf } = await import('@/lib/backtest/injectForwardPerf');
  const { saveScanSession } = await import('@/lib/storage/scanStorage');
  const { getActiveStrategyServer } = await import('@/lib/strategy/activeStrategyServer');
  const strategy = await getActiveStrategyServer();

  const scanner = new TaiwanScanner();
  const allStocks = await scanner.getStockList();
  if (allStocks.length < 1500) {
    throw new Error(`Y track stock universe ${allStocks.length} < 1500`);
  }
  const rankMap = await computeTurnoverRankAsOfDate('TW', allStocks, date, BOOK_UNIVERSE_TOP_N);
  const stocks = allStocks.filter((stock) => rankMap.has(stock.symbol));
  if (stocks.length < Math.floor(BOOK_UNIVERSE_TOP_N * 0.9)) {
    throw new Error(`Y track turnover universe ${stocks.length} < ${Math.floor(BOOK_UNIVERSE_TOP_N * 0.9)}`);
  }

  // 先修可修的當日資料，再用策略真正需要的兩個完整 5 日窗做 fail-closed 閘門。
  // 覆蓋不足時不執行、更不覆寫既有 post_close session，避免 partial 結果被當成 0 命中。
  const symbols = stocks.map(stock => stock.symbol);
  const repair = await repairYTrackCurrentData(date, symbols);
  const readiness = await assessYTrackReadiness(date, symbols);
  if (!readiness.ready) {
    throw new Error(`Y track data not ready: ${readiness.reasons.join('; ')}`);
  }

  const results = await scanner.scanInstSteal(stocks, date, 'long', 15);
  await injectForwardPerf(results, date, `Y-track:${date}`);
  await saveScanSession({
    id: `TW-long-Y-${date}-${Date.now()}`,
    strategyId: strategy.id,
    market: 'TW',
    date,
    direction: 'long',
    multiTimeframeEnabled: false,
    sessionType: 'post_close',
    scanTime: new Date().toISOString(),
    resultCount: results.length,
    results,
    marketTrend: '',
    buyMethod: 'Y',
    step1Filter: 'bypassed',
    dataFreshness: {
      avgStaleDays: 0,
      maxStaleDays: 0,
      staleCount: readiness.tradedPool - readiness.strategyWindow.count,
      totalScanned: readiness.tradedPool,
      coverageRate: +(readiness.strategyWindow.coverage * 100).toFixed(2),
      dataStatus: readiness.strategyWindow.coverage === 1 ? 'complete' : 'partial',
    },
  }, { allowOverwritePostClose: true });

  return {
    date,
    universe: readiness.strategyWindow.count,
    requestedUniverse: stocks.length,
    resultCount: results.length,
    results,
    readiness,
    repair,
  };
}
