/** Replay a complete, archived Fugle universe; never promote an incomplete noon snapshot. */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { normalizeFugle30mToEndGrid } from '@/lib/candles30m/Candle30mStore';
import { scanSixConditions30m } from '@/lib/candles30m/sixConditions30mScan';
import { isCompleteMarketIndexCandle } from '@/lib/datasource/marketIndexQuality';
import { saveScanSession } from '@/lib/storage/scanStorage';
import { getActiveStrategyServer } from '@/lib/strategy/activeStrategyServer';
import type { Candle } from '@/types';
import type { StockScanResult } from '@/lib/scanner/types';

async function main() {
  const [date, sourceDir, universeFile] = process.argv.slice(2);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date ?? '') || !sourceDir || !universeFile) {
    throw new Error('Usage: replay-a30-history.ts YYYY-MM-DD source-dir universe.json');
  }
  const universe: Array<{ symbol: string; name: string; rank: number }> = JSON.parse(await fs.readFile(universeFile, 'utf8'));
  if (universe.length !== 500 || new Set(universe.map(s => s.symbol)).size !== 500) throw new Error('Expected 500 unique ranked stocks');
  const bars: Record<string, Candle[]> = {};
  const meta = new Map(universe.map(s => [s.symbol, { name: s.name, turnoverRank: s.rank }]));
  const report: { symbol: string; bars: number; volumeRatio: number | null; status: string }[] = [];
  for (const stock of universe) {
    const raw = JSON.parse(await fs.readFile(path.join(sourceDir, `${stock.symbol}.json`), 'utf8'));
    if (raw.symbol !== stock.symbol.split('.')[0] || raw.timeframe !== '30') throw new Error(`Source identity mismatch: ${stock.symbol}`);
    const candles: Candle[] = raw.data.map((c: Candle) => ({ ...c, date: c.date.replace('T', ' ').slice(0, 16) }))
      .filter((c: Candle) => c.date.slice(0, 10) <= date).sort((a: Candle, b: Candle) => a.date.localeCompare(b.date));
    if (new Set(candles.map(c => c.date)).size !== candles.length || candles.some(c => !isCompleteMarketIndexCandle(c))) {
      throw new Error(`Invalid/duplicate source bar: ${stock.symbol}`);
    }
    const normalized = normalizeFugle30mToEndGrid(candles);
    const daily = JSON.parse(await fs.readFile(path.join('data/candles/TW', `${stock.symbol}.json`), 'utf8'))
      .candles.find((c: Candle) => c.date === date) as Candle | undefined;
    const today = normalized.filter(c => c.date.startsWith(date));
    if (!daily) {
      if (today.length) throw new Error(`Minute data exists but daily is absent: ${stock.symbol}`);
      report.push({ symbol: stock.symbol, bars: 0, volumeRatio: null, status: 'no daily trading bar' });
      continue;
    }
    if (!today.length || normalized.filter(c => c.date < date).length < 60 || today.at(-1)?.date !== `${date} 13:30`) {
      throw new Error(`Incomplete final bar or warm-up: ${stock.symbol}`);
    }
    // Daily volume includes additional sessions/odd lots; compare OHLC, record volume separately.
    const prices = [today[0].open, Math.max(...today.map(c => c.high)), Math.min(...today.map(c => c.low)), today.at(-1)!.close];
    const expected = [daily.open, daily.high, daily.low, daily.close];
    if (prices.some((v, i) => Math.abs(v - expected[i]) > 0.011)) throw new Error(`Minute/daily OHLC mismatch: ${stock.symbol}`);
    bars[stock.symbol] = normalized;
    report.push({ symbol: stock.symbol, bars: today.length, volumeRatio: today.reduce((s, c) => s + c.volume, 0) / daily.volume, status: 'verified' });
  }
  const accumulated = new Map<string, StockScanResult>();
  const rounds: { time: string; passed: number; evaluated: number }[] = [];
  for (const time of ['09:30', '10:00', '10:30', '11:00', '11:30', '12:00', '12:30', '13:00', '13:30']) {
    const cutoff = `${date} ${time}`;
    const inputs: Record<string, Candle[]> = Object.fromEntries(
      Object.entries(bars).map(([s, cs]) => [s, cs.filter(c => c.date <= cutoff)]),
    );
    const scan = scanSixConditions30m(inputs, meta, `${date}T${time}:00+08:00`);
    for (const row of scan.results) accumulated.set(row.symbol, row);
    rounds.push({ time, passed: scan.results.length, evaluated: scan.stats.evaluated });
  }
  const results = [...accumulated.values()].sort((a, b) => b.sixConditionsScore - a.sixConditionsScore || b.changePercent - a.changePercent);
  const strategy = await getActiveStrategyServer();
  await fs.writeFile(path.join(sourceDir, 'verification.json'), JSON.stringify({ date, source: 'Fugle historical 30m', report, rounds, resultCount: results.length }, null, 2));
  await saveScanSession({
    id: `TW-long-daily30-${date}-replay`, strategyId: strategy.id, market: 'TW', date,
    direction: 'long', timeframe: '30m', schemaVersion: 'v12', sessionType: 'post_close',
    scanTime: new Date().toISOString(), resultCount: results.length, results, step1Filter: 'bypassed',
  });
  console.log(`${date}: ${Object.keys(bars).length}/500 verified, 9 rounds replayed, ${results.length} results saved`);
}
main().catch(error => { console.error(error); process.exitCode = 1; });
