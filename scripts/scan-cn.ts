import { ChinaScanner } from '../lib/scanner/ChinaScanner';
import { ScanSession } from '../lib/scanner/types';
import { saveScanSession } from '../lib/storage/scanStorage';
import { ZHU_V1 } from '../lib/strategy/StrategyConfig';
import { isTradingDay } from '../lib/utils/tradingDay';

const DATES = ['2026-04-09','2026-04-08','2026-04-07','2026-04-03','2026-04-02','2026-04-01','2026-03-31','2026-03-30','2026-03-27','2026-03-26','2026-03-25','2026-03-24','2026-03-23','2026-03-20','2026-03-19','2026-03-18','2026-03-17','2026-03-16','2026-03-13'];

(async () => {
  const scanner = new ChinaScanner();
  const stocks = await scanner.getStockList();
  console.log('CN stocks:', stocks.length);

  for (const date of DATES) {
    if (!isTradingDay(date, 'CN')) { console.log('[SKIP]', date); continue; }
    process.stdout.write('[CN] ' + date + '... ');
    try {
      const opts = { ...ZHU_V1.thresholds };
      const [daily, mtf] = await Promise.all([
        scanner.scanSOP(stocks, date),
        scanner.scanSOP(stocks, date, { ...opts, multiTimeframeFilter: true }),
      ]);
      const d = daily as any, m = mtf as any;
      const sessions: ScanSession[] = [
        { id: `CN-long-daily-${date}-${Date.now()}`, market:'CN', date, direction:'long', multiTimeframeEnabled:false, scanTime: new Date().toISOString(), resultCount: d.results.length, results: d.results, dataFreshness: d.sessionFreshness },
        { id: `CN-long-mtf-${date}-${Date.now()}`,   market:'CN', date, direction:'long', multiTimeframeEnabled:true,  scanTime: new Date().toISOString(), resultCount: m.results.length, results: m.results, dataFreshness: m.sessionFreshness },
        { id: `CN-short-daily-${date}-${Date.now()}`, market:'CN', date, direction:'short', multiTimeframeEnabled:false, scanTime: new Date().toISOString(), resultCount: 0, results: [], dataFreshness: undefined },
        { id: `CN-short-mtf-${date}-${Date.now()}`,   market:'CN', date, direction:'short', multiTimeframeEnabled:true,  scanTime: new Date().toISOString(), resultCount: 0, results: [], dataFreshness: undefined },
      ];
      for (const s of sessions) await saveScanSession(s);
      console.log('daily=' + d.results.length + ', mtf=' + m.results.length);
    } catch(e: any) { console.error('ERROR: ' + e.message); }
  }
  console.log('CN DONE');
})();
