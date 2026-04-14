/**
 * 手動觸發 L1 校驗（不下載，只讀現有檔案）
 * Usage: npx tsx scripts/verify-now.ts TW
 *        npx tsx scripts/verify-now.ts CN
 */
import { verifyDownload } from '../lib/datasource/DownloadVerifier';
import { getLastTradingDay } from '../lib/datasource/marketHours';

async function main() {
  const market = (process.argv[2] || 'TW') as 'TW' | 'CN';

  const date = getLastTradingDay(market);

  // 取得股票清單
  let symbols: string[];
  if (market === 'TW') {
    const { TaiwanScanner } = await import('../lib/scanner/TaiwanScanner');
    const scanner = new TaiwanScanner();
    const stocks = await scanner.getStockList();
    symbols = stocks.map(s => s.symbol);
  } else {
    const { ChinaScanner } = await import('../lib/scanner/ChinaScanner');
    const scanner = new ChinaScanner();
    const stocks = await scanner.getStockList();
    symbols = stocks.map(s => s.symbol);
  }

  console.log(`[verify] ${market} ${date}: 校驗 ${symbols.length} 支股票...`);

  const report = await verifyDownload(market, date, symbols, {
    succeeded: symbols.length,
    failed: 0,
    skipped: 0,
  });

  console.log(`\n=== ${market} L1 校驗結果 ===`);
  console.log(`日期: ${date}`);
  console.log(`健康: ${report.health}`);
  console.log(`覆蓋率: ${(report.summary.coverageRate * 100).toFixed(1)}%`);
  console.log(`有 gap: ${report.summary.stocksWithGaps} 支`);
  console.log(`過期: ${report.summary.stocksStale} 支`);
  console.log(`讀取失敗: ${report.summary.stocksReadFailed} 支`);
  console.log(`乾淨: ${report.summary.stocksClean} 支`);
  console.log(`報告已存: reports/verify-${market}-${date}.json`);
}

main().catch(console.error);
