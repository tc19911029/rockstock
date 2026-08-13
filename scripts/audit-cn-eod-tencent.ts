/** 全量逐檔用 Tencent qfq 日線核對／修復 CN L1 指定日 OHLCV。 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { Candle } from '../types';
import { readCandleFile } from '../lib/datasource/CandleStorageAdapter';
import { saveLocalCandles } from '../lib/datasource/LocalCandleStore';
import { tencentVolumeMultiplier } from '../lib/datasource/TencentHistProvider';
import { TENCENT_FQKLINE_BASES } from '../lib/datasource/tencentKlineHosts';

const date = process.argv[process.argv.indexOf('--date') + 1];
const apply = process.argv.includes('--apply');
if (!/^\d{4}-\d{2}-\d{2}$/.test(date || '')) throw new Error('Usage: --date YYYY-MM-DD [--apply]');
const dir = path.join(process.cwd(), 'data', 'candles', 'CN');
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

type Result = { kind: 'bar'; bar: Candle } | { kind: 'no-trade' } | { kind: 'fetch-failed'; error: string };

async function fetchOne(symbol: string): Promise<Result> {
  const m = symbol.match(/^(\d{6})\.(SS|SZ)$/);
  if (!m) return { kind: 'fetch-failed', error: 'bad symbol' };
  const tc = `${m[2] === 'SS' ? 'sh' : 'sz'}${m[1]}`;
  const query = `?param=${tc},day,${date},${date},1,qfq`;
  let lastError = '';
  for (let attempt = 0; attempt < 3; attempt++) {
    for (const base of TENCENT_FQKLINE_BASES) {
      try {
        const res = await fetch(base + query, { signal: AbortSignal.timeout(12_000), headers: { 'User-Agent': 'Mozilla/5.0' } });
        if (!res.ok) { lastError = `HTTP ${res.status}`; continue; }
        const json = await res.json() as { code?: number; data?: Record<string, { qfqday?: string[][]; day?: string[][] }> };
        if (json.code !== 0 || !json.data) { lastError = `code=${json.code}`; continue; }
        const node = json.data[tc] ?? Object.values(json.data)[0];
        const row = (node?.qfqday ?? node?.day ?? []).find(r => r[0] === date);
        if (!row) return { kind: 'no-trade' };
        const mult = tencentVolumeMultiplier(tc, true);
        return { kind: 'bar', bar: {
          date, open: Number(row[1]), close: Number(row[2]), high: Number(row[3]), low: Number(row[4]),
          volume: Math.round(Number(row[5]) * mult),
        } };
      } catch (err) { lastError = String(err); }
    }
    await sleep(250 * (attempt + 1));
  }
  return { kind: 'fetch-failed', error: lastError };
}

const priceSame = (a: Candle | undefined, b: Candle) => !!a &&
  (['open', 'high', 'low', 'close'] as const).every(k => Math.abs(a[k] - b[k]) < 0.000001);

async function main() {
  const symbols = (await fs.readdir(dir)).filter(f => /^\d{6}\.(SS|SZ)\.json$/.test(f)).map(f => f.slice(0, -5));
  let cursor = 0, checked = 0, exact = 0, repaired = 0, noTrade = 0, missingLocalDate = 0, fetchFailed = 0;
  let volumeWithin100 = 0, volumeMismatch = 0, writeFailed = 0;
  const failures: string[] = [], noTradeSymbols: string[] = [], repairedSymbols: string[] = [];
  const concurrency = 10;

  async function worker() {
    for (;;) {
      const i = cursor++;
      if (i >= symbols.length) return;
      const symbol = symbols[i];
      const result = await fetchOne(symbol);
      if (result.kind === 'fetch-failed') { fetchFailed++; failures.push(`${symbol}: ${result.error}`); continue; }
      if (result.kind === 'no-trade') { noTrade++; noTradeSymbols.push(symbol); continue; }
      checked++;
      const local = await readCandleFile(symbol, 'CN');
      const actual = local?.candles.find(c => c.date === date);
      if (!actual) missingLocalDate++;
      const volDiff = actual ? Math.abs(actual.volume - result.bar.volume) : Infinity;
      if (volDiff <= 100) volumeWithin100++; else volumeMismatch++;
      if (priceSame(actual, result.bar) && volDiff <= 100) { exact++; continue; }
      if (apply) {
        const repairedBar = { ...result.bar, volume: volDiff <= 100 && actual ? actual.volume : result.bar.volume };
        try { await saveLocalCandles(symbol, 'CN', [repairedBar]); }
        catch (err) { writeFailed++; failures.push(`${symbol} write: ${String(err)}`); continue; }
      }
      repaired++; repairedSymbols.push(symbol);
    }
  }

  const progress = setInterval(() => console.log(`[CN Tencent] ${Math.min(cursor, symbols.length)}/${symbols.length} checked=${checked} repair=${repaired} noTrade=${noTrade} fail=${fetchFailed}`), 10_000);
  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  clearInterval(progress);

  let remainingMismatch = 0;
  if (apply) {
    for (const symbol of repairedSymbols) {
      const local = await readCandleFile(symbol, 'CN');
      const actual = local?.candles.find(c => c.date === date);
      const result = await fetchOne(symbol);
      if (result.kind !== 'bar' || !priceSame(actual, result.bar) || !actual || Math.abs(actual.volume - result.bar.volume) > 100) remainingMismatch++;
    }
  }
  const report = { generatedAt: new Date().toISOString(), date, apply, totalFiles: symbols.length, checked, exact,
    repaired, missingLocalDate, noTrade, fetchFailed, volumeWithin100, volumeMismatch, writeFailed,
    remainingMismatch, noTradeSymbols, failures, repairedSymbols };
  const reportDir = path.join(process.cwd(), 'data', 'reports');
  await fs.mkdir(reportDir, { recursive: true });
  await fs.writeFile(path.join(reportDir, `audit-cn-tencent-${date}.json`), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ ...report, noTradeSymbols: noTradeSymbols.slice(0, 20), failures: failures.slice(0, 20), repairedSymbols: repairedSymbols.slice(0, 50) }, null, 2));
  if (fetchFailed || writeFailed || remainingMismatch) process.exitCode = 1;
}

main().catch(err => { console.error(err); process.exit(1); });
