/**
 * Exact re-scan audit for limit-up stocks inside the configured book universe.
 *
 * This deliberately calls MarketScanner.scanSOP with the active strategy and
 * today's L2 snapshot.  Any symbol that passes here but is absent from the
 * persisted scan is a real pipeline/storage omission; symbols rejected here
 * were intentionally filtered by the same production gates.
 */
import { existsSync, readFileSync } from 'fs';
import path from 'path';

import { ChinaScanner } from '../lib/scanner/ChinaScanner';
import { TaiwanScanner } from '../lib/scanner/TaiwanScanner';
import type { RealtimeQuoteForScan, StockEntry } from '../lib/scanner/MarketScanner';
import { getActiveStrategyServer } from '../lib/strategy/activeStrategyServer';
import { BOOK_UNIVERSE_TOP_N } from '../lib/scanner/universeTopN';

type Market = 'TW' | 'CN';
type Quote = RealtimeQuoteForScan & {
  symbol: string;
  name?: string;
  changePercent: number;
};

const dateArg = process.argv[process.argv.indexOf('--date') + 1];
const date = dateArg && /^\d{4}-\d{2}-\d{2}$/.test(dateArg)
  ? dateArg
  : new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Taipei' }).format(new Date());

function readJson<T>(file: string): T {
  return JSON.parse(readFileSync(file, 'utf8')) as T;
}

function persistedSymbols(market: Market): Set<string> {
  const letters = ['daily', 'B', 'C', 'D', 'E', 'F', 'J', 'K', 'L', 'M', 'N', 'O', 'P', 'Q', 'R'];
  const found = new Set<string>();
  for (const letter of letters) {
    const file = path.join(process.cwd(), 'data', `scan-${market}-long-${letter}-${date}.json`);
    if (!existsSync(file)) continue;
    const data = readJson<{ results?: Array<{ symbol?: string; code?: string }> }>(file);
    for (const row of data.results ?? []) {
      const code = (row.symbol ?? row.code ?? '').replace(/\.(TW|TWO|SS|SZ)$/i, '');
      if (code) found.add(code);
    }
  }
  return found;
}

async function run(market: Market) {
  const snapshot = readJson<{ quotes: Quote[] }>(path.join(process.cwd(), 'data', `intraday-${market}-${date}.json`));
  const ranked = readJson<{ symbols: string[] }>(path.join(process.cwd(), 'data', 'turnover-rank', `${market}.json`))
    .symbols.slice(0, BOOK_UNIVERSE_TOP_N);
  const quoteMap = new Map(snapshot.quotes.map(q => [q.symbol.replace(/\.(TW|TWO|SS|SZ)$/i, ''), q]));
  const persisted = persistedSymbols(market);
  const candidates: StockEntry[] = ranked.flatMap(symbol => {
    const code = symbol.replace(/\.(TW|TWO|SS|SZ)$/i, '');
    const q = quoteMap.get(code);
    return q && q.changePercent >= 9.5 && !persisted.has(code)
      ? [{ symbol, name: q.name ?? code }]
      : [];
  });

  const scanner = market === 'TW' ? new TaiwanScanner() : new ChinaScanner();
  scanner.setRealtimeQuotes(new Map(snapshot.quotes.map(q => [
    q.symbol.replace(/\.(TW|TWO|SS|SZ)$/i, ''),
    { open: q.open, high: q.high, low: q.low, close: q.close, volume: q.volume, date },
  ])));
  const strategy = await getActiveStrategyServer();
  const rescanned = await scanner.scanSOP(candidates, date, strategy.thresholds, 'sixConditions', false);
  const passed = rescanned.results.map(r => r.symbol.replace(/\.(TW|TWO|SS|SZ)$/i, ''));
  console.log(JSON.stringify({
    market,
    date,
    strategy: strategy.id,
    candidates: candidates.length,
    intentionallyRejected: candidates.length - passed.length,
    realPipelineOmissions: passed,
    diagnostics: rescanned.diagnostics,
  }, null, 2));
}

async function main() {
  await run('TW');
  await run('CN');
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
