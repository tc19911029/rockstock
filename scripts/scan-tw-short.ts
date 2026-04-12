import { TaiwanScanner } from '../lib/scanner/TaiwanScanner';
import { ScanSession } from '../lib/scanner/types';
import { saveScanSession } from '../lib/storage/scanStorage';
import { ZHU_V1 } from '../lib/strategy/StrategyConfig';
import { isTradingDay } from '../lib/utils/tradingDay';

const DATES = ['2026-04-09','2026-04-08','2026-04-07','2026-04-02','2026-04-01','2026-03-31','2026-03-30','2026-03-27','2026-03-26','2026-03-25','2026-03-24','2026-03-23','2026-03-20','2026-03-19','2026-03-18','2026-03-17','2026-03-16','2026-03-13','2026-03-12'];

(async () => {
  const scanner = new TaiwanScanner();
  const stocks = await scanner.getStockList();
  console.log('TW stocks:', stocks.length);

  for (const date of DATES) {
    if (!isTradingDay(date, 'TW')) { console.log('[SKIP]', date); continue; }
    process.stdout.write('[TW-short] ' + date + '... ');
    try {
      const opts = { ...ZHU_V1.thresholds };
      const [daily, mtf] = await Promise.all([
        scanner.scanShortCandidates(stocks, date),
        scanner.scanShortCandidates(stocks, date, { ...opts, multiTimeframeFilter: true }),
      ]);
      const d = daily as any, m = mtf as any;
      const sessions: ScanSession[] = [
        { id: `TW-short-daily-${date}-${Date.now()}`, market:'TW', date, direction:'short', multiTimeframeEnabled:false, scanTime: new Date().toISOString(), resultCount: d.candidates.length, results: d.candidates, dataFreshness: d.sessionFreshness },
        { id: `TW-short-mtf-${date}-${Date.now()}`,   market:'TW', date, direction:'short', multiTimeframeEnabled:true,  scanTime: new Date().toISOString(), resultCount: m.candidates.length, results: m.candidates, dataFreshness: m.sessionFreshness },
      ];
      for (const s of sessions) await saveScanSession(s);
      console.log('daily=' + d.candidates.length + ', mtf=' + m.candidates.length);
    } catch(e: any) { console.error('ERROR: ' + e.message); }
  }
  console.log('TW short DONE');
})();
