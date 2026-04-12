import { TaiwanScanner } from '../lib/scanner/TaiwanScanner';
import { ChinaScanner } from '../lib/scanner/ChinaScanner';
import { ScanSession } from '../lib/scanner/types';
import { saveScanSession } from '../lib/storage/scanStorage';
import { ZHU_V1 } from '../lib/strategy/StrategyConfig';
import { isTradingDay } from '../lib/utils/tradingDay';

const TW_DATES = ['2026-04-09','2026-04-08','2026-04-07','2026-04-02','2026-04-01','2026-03-31','2026-03-30','2026-03-27','2026-03-26','2026-03-25','2026-03-24','2026-03-23','2026-03-20','2026-03-19','2026-03-18','2026-03-17','2026-03-16','2026-03-13','2026-03-12'];
const CN_DATES = ['2026-04-10','2026-04-09','2026-04-08','2026-04-07','2026-04-03','2026-04-02','2026-04-01','2026-03-31','2026-03-30','2026-03-27','2026-03-26','2026-03-25','2026-03-24','2026-03-23','2026-03-20','2026-03-19','2026-03-18','2026-03-17','2026-03-16','2026-03-13'];

async function scanTW(scanner: TaiwanScanner, stocks: any[], date: string) {
  const opts = { ...ZHU_V1.thresholds };
  const [daily, mtf] = await Promise.all([
    scanner.scanSOP(stocks, date),
    scanner.scanSOP(stocks, date, { ...opts, multiTimeframeFilter: true }),
  ]);
  const d = daily as any;
  const m = mtf as any;
  return {
    longDaily: d.results,
    longMtf: m.results,
    marketTrend: d.marketTrend,
    dailyFreshness: d.sessionFreshness,
    mtfFreshness: m.sessionFreshness,
  };
}

async function scanCN(scanner: ChinaScanner, stocks: any[], date: string) {
  const opts = { ...ZHU_V1.thresholds };
  const [daily, mtf] = await Promise.all([
    scanner.scanSOP(stocks, date),
    scanner.scanSOP(stocks, date, { ...opts, multiTimeframeFilter: true }),
  ]);
  const d = daily as any;
  const m = mtf as any;
  return {
    longDaily: d.results,
    longMtf: m.results,
    marketTrend: undefined as string | undefined,
    dailyFreshness: d.sessionFreshness,
    mtfFreshness: m.sessionFreshness,
  };
}

async function saveSessions(sessions: ScanSession[]) {
  for (const s of sessions) {
    await saveScanSession(s);
  }
}

async function main() {
  // ── TW ──────────────────────────────────────────────────────
  const twScanner = new TaiwanScanner();
  const twStocks = await twScanner.getStockList();
  console.log(`TW stocks: ${twStocks.length}\n`);

  for (const date of TW_DATES) {
    if (!isTradingDay(date, 'TW')) { console.log(`[SKIP] ${date} 非交易日`); continue; }
    process.stdout.write(`[TW] ${date}... `);
    try {
      const { longDaily, longMtf, marketTrend, dailyFreshness, mtfFreshness } = await scanTW(twScanner, twStocks, date);
      await saveSessions([
        { id: `TW-long-daily-${date}-${Date.now()}`, market:'TW', date, direction:'long', multiTimeframeEnabled:false, scanTime: new Date().toISOString(), resultCount: longDaily.length, results: longDaily, dataFreshness: dailyFreshness },
        { id: `TW-long-mtf-${date}-${Date.now()}`,   market:'TW', date, direction:'long', multiTimeframeEnabled:true,  scanTime: new Date().toISOString(), resultCount: longMtf.length,   results: longMtf,   dataFreshness: mtfFreshness },
        { id: `TW-short-daily-${date}-${Date.now()}`, market:'TW', date, direction:'short', multiTimeframeEnabled:false, scanTime: new Date().toISOString(), resultCount: 0, results: [], dataFreshness: undefined },
        { id: `TW-short-mtf-${date}-${Date.now()}`,   market:'TW', date, direction:'short', multiTimeframeEnabled:true,  scanTime: new Date().toISOString(), resultCount: 0, results: [], dataFreshness: undefined },
      ]);
      console.log(`daily=${longDaily.length}, mtf=${longMtf.length}, trend=${marketTrend ?? 'N/A'}`);
    } catch (e: any) {
      console.error(`ERROR: ${e.message}`);
    }
  }

  // ── CN ──────────────────────────────────────────────────────
  const cnScanner = new ChinaScanner();
  const cnStocks = await cnScanner.getStockList();
  console.log(`\nCN stocks: ${cnStocks.length}\n`);

  for (const date of CN_DATES) {
    if (!isTradingDay(date, 'CN')) { console.log(`[SKIP] ${date} 非交易日`); continue; }
    process.stdout.write(`[CN] ${date}... `);
    try {
      const { longDaily, longMtf, dailyFreshness, mtfFreshness } = await scanCN(cnScanner, cnStocks, date);
      await saveSessions([
        { id: `CN-long-daily-${date}-${Date.now()}`, market:'CN', date, direction:'long', multiTimeframeEnabled:false, scanTime: new Date().toISOString(), resultCount: longDaily.length, results: longDaily, dataFreshness: dailyFreshness },
        { id: `CN-long-mtf-${date}-${Date.now()}`,   market:'CN', date, direction:'long', multiTimeframeEnabled:true,  scanTime: new Date().toISOString(), resultCount: longMtf.length,   results: longMtf,   dataFreshness: mtfFreshness },
        { id: `CN-short-daily-${date}-${Date.now()}`, market:'CN', date, direction:'short', multiTimeframeEnabled:false, scanTime: new Date().toISOString(), resultCount: 0, results: [], dataFreshness: undefined },
        { id: `CN-short-mtf-${date}-${Date.now()}`,   market:'CN', date, direction:'short', multiTimeframeEnabled:true,  scanTime: new Date().toISOString(), resultCount: 0, results: [], dataFreshness: undefined },
      ]);
      console.log(`daily=${longDaily.length}, mtf=${longMtf.length}`);
    } catch (e: any) {
      console.error(`ERROR: ${e.message}`);
    }
  }

  console.log('\n=== ALL DONE ===');
}

main().catch(console.error);
