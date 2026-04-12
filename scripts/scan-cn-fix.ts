import { ChinaScanner } from '../lib/scanner/ChinaScanner';
import { saveScanSession } from '../lib/storage/scanStorage';

const DATES = [
  '2026-04-10','2026-04-09','2026-04-08','2026-04-07',
  '2026-04-03','2026-04-02','2026-04-01',
  '2026-03-31','2026-03-30','2026-03-27','2026-03-26',
  '2026-03-25','2026-03-24','2026-03-23','2026-03-20',
  '2026-03-19','2026-03-18','2026-03-17','2026-03-16','2026-03-13',
];

function mkSession(
  market: 'CN',
  direction: 'long' | 'short',
  mode: 'daily' | 'mtf',
  date: string,
  results: any[]
) {
  const now = Date.now();
  return {
    id: `CN-${direction}-${mode}-${date}-${now}`,
    market: market as 'CN',
    date,
    direction,
    multiTimeframeEnabled: mode === 'mtf',
    scanTime: new Date().toISOString(),
    resultCount: results.length,
    results,
  };
}

(async () => {
  const scanner = new ChinaScanner();
  const stocks = await scanner.getStockList();
  console.log('CN stocks:', stocks.length);

  for (const date of DATES) {
    process.stdout.write('[CN] ' + date + '... ');
    try {
      // LONG
      const longDaily = await scanner.scanSOP(stocks, date);
      await saveScanSession(mkSession('CN', 'long', 'daily', date, longDaily.results));
      process.stdout.write('L' + longDaily.results.length + ' ');
      await new Promise(r => setTimeout(r, 1500));

      const longMtf = await scanner.scanSOP(stocks, date);
      await saveScanSession(mkSession('CN', 'long', 'mtf', date, longMtf.results));
      process.stdout.write('Lm' + longMtf.results.length + ' ');
      await new Promise(r => setTimeout(r, 1500));

      // SHORT
      const shortDaily = await scanner.scanShortCandidates(stocks, date);
      await saveScanSession(mkSession('CN', 'short', 'daily', date, shortDaily.candidates));
      process.stdout.write('S' + shortDaily.candidates.length + ' ');
      await new Promise(r => setTimeout(r, 1500));

      const shortMtf = await scanner.scanShortCandidates(stocks, date);
      await saveScanSession(mkSession('CN', 'short', 'mtf', date, shortMtf.candidates));
      process.stdout.write('Sm' + shortMtf.candidates.length);
      console.log();
    } catch(e: any) { console.error(' ERROR: ' + e.message); }
    await new Promise(r => setTimeout(r, 2000));
  }

  console.log('CN DONE');
})();
