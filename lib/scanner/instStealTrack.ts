import { BOOK_UNIVERSE_TOP_N } from './universeTopN';

export async function runInstStealTrack(date: string) {
  const { TaiwanScanner } = await import('./TaiwanScanner');
  const { computeTurnoverRankAsOfDate } = await import('./TurnoverRank');
  const { injectForwardPerf } = await import('@/lib/backtest/injectForwardPerf');
  const { saveScanSession } = await import('@/lib/storage/scanStorage');

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

  const results = await scanner.scanInstSteal(stocks, date, 'long', 15);
  await injectForwardPerf(results, date, `Y-track:${date}`);
  await saveScanSession({
    id: `TW-long-Y-${date}-${Date.now()}`,
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
  }, { allowOverwritePostClose: true });

  return { date, universe: stocks.length, resultCount: results.length, results };
}
