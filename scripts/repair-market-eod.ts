/**
 * 用盤後權威資料修復指定交易日並輸出逐市場驗證報告。
 *
 * TW：TWSE MI_INDEX + TPEx OpenAPI，官方 OHLCV 完整覆寫 canonical L1。
 * CN：snapshot 只修「H/L/C 已一致但 open 單欄錯」；H/L/C 差異留給 Tencent qfq
 *     全量腳本，避免除權後拿 raw snapshot 覆蓋前復權歷史價。
 *
 * Usage:
 *   npx tsx scripts/repair-market-eod.ts --date 2026-08-12 --market ALL --apply
 */
import { config } from 'dotenv';
import { existsSync, promises as fs } from 'node:fs';
import path from 'node:path';

if (existsSync('.env.local')) config({ path: '.env.local' });
config();

import type { Candle } from '../types';
import { prefetchVendorBatch } from '../lib/datasource/eodSettleBatch';
import { readCandleFile } from '../lib/datasource/CandleStorageAdapter';
import { saveLocalCandles } from '../lib/datasource/LocalCandleStore';
import { expectedTwSymbol } from '../lib/datasource/twSymbolMarket';
import { fetchJsonWithCurlFallback } from '../lib/datasource/curlFetch';

type MarketArg = 'TW' | 'CN' | 'ALL';
type Summary = Record<string, number | string | string[]>;

const dateArg = process.argv[process.argv.indexOf('--date') + 1];
const marketArg = ((process.argv[process.argv.indexOf('--market') + 1] || 'ALL').toUpperCase()) as MarketArg;
const apply = process.argv.includes('--apply');
if (!/^\d{4}-\d{2}-\d{2}$/.test(dateArg || '') || !['TW', 'CN', 'ALL'].includes(marketArg)) {
  throw new Error('Usage: --date YYYY-MM-DD [--market TW|CN|ALL] [--apply]');
}
const targetDate = dateArg;
const root = process.cwd();

const sameBar = (a: Candle | undefined, b: Candle, includeVolume: boolean) => !!a &&
  Math.abs(a.open - b.open) < 0.000001 && Math.abs(a.high - b.high) < 0.000001 &&
  Math.abs(a.low - b.low) < 0.000001 && Math.abs(a.close - b.close) < 0.000001 &&
  (!includeVolume || a.volume === b.volume);

async function repairTw(): Promise<Summary> {
  const cache = await prefetchVendorBatch('TW', targetDate);
  if (cache.twseBulk.size === 0 || cache.tpexBulk.size === 0) {
    throw new Error(`TW 官方 bulk 不完整：TWSE=${cache.twseBulk.size}, TPEx=${cache.tpexBulk.size}`);
  }
  const dir = path.join(root, 'data', 'candles', 'TW');
  const files = (await fs.readdir(dir)).filter(f => f.endsWith('.json'));
  let officialActive = 0, alreadyExact = 0, repaired = 0, missingOfficial = 0, writeFailed = 0;
  const ghosts: string[] = [];
  const missingSymbols: string[] = [];

  for (const file of files) {
    const symbol = file.slice(0, -5);
    const expected = await expectedTwSymbol(symbol);
    if (expected && expected !== symbol.toUpperCase()) {
      ghosts.push(symbol);
      continue;
    }
    const match = symbol.match(/^(.+)\.(TW|TWO)$/i);
    if (!match) continue;
    const row = match[2].toUpperCase() === 'TWO' ? cache.tpexBulk.get(match[1]) : cache.twseBulk.get(match[1]);
    if (!row) { missingOfficial++; missingSymbols.push(symbol); continue; }
    officialActive++;
    const expectedBar: Candle = { date: targetDate, ...row };
    const local = await readCandleFile(symbol, 'TW');
    const actual = local?.candles.find(c => c.date === targetDate);
    if (sameBar(actual, expectedBar, true)) { alreadyExact++; continue; }
    if (apply) {
      try { await saveLocalCandles(symbol, 'TW', [expectedBar]); }
      catch (err) { writeFailed++; console.warn(`[TW] ${symbol}: ${(err as Error).message}`); continue; }
    }
    repaired++;
  }

  if (apply && ghosts.length > 0) {
    const quarantine = path.join(root, 'data', 'quarantine', 'candles', 'TW');
    await fs.mkdir(quarantine, { recursive: true });
    for (const symbol of ghosts) {
      const src = path.join(dir, `${symbol}.json`);
      const dst = path.join(quarantine, `${symbol}.json`);
      if (existsSync(src) && !existsSync(dst)) await fs.rename(src, dst);
    }
  }

  // 官方「全表」會保留零成交列；用它把缺棒分成 no-trade 與 not-in-daily-table，
  // 避免把停牌／下市誤報為漏抓，也避免用昨收製造零量假 K。
  const twseAll = new Set<string>();
  const miUrl = `https://www.twse.com.tw/exchangeReport/MI_INDEX?response=json&date=${targetDate.replaceAll('-', '')}&type=ALLBUT0999`;
  const { data: mi } = await fetchJsonWithCurlFallback<{ tables?: Array<{ fields?: string[]; data?: string[][] }> }>(miUrl, { timeoutMs: 30_000 });
  const miTable = mi.tables?.find(t => t.fields?.some(f => f.replace(/\s/g, '') === '證券代號') && t.fields?.some(f => f.replace(/\s/g, '') === '收盤價'));
  const codeIdx = miTable?.fields?.findIndex(f => f.replace(/\s/g, '') === '證券代號') ?? -1;
  if (codeIdx >= 0) for (const row of miTable?.data ?? []) if (row[codeIdx]) twseAll.add(row[codeIdx].trim());
  const tpexAll = new Set<string>();
  const tpUrl = `https://www.tpex.org.tw/www/zh-tw/afterTrading/otc?date=${targetDate.replaceAll('-', '/')}&type=EW&response=json`;
  const { data: tp } = await fetchJsonWithCurlFallback<{ tables?: Array<{ data?: string[][] }> }>(tpUrl, { timeoutMs: 30_000 });
  for (const row of tp.tables?.[0]?.data ?? []) if (row[0]) tpexAll.add(String(row[0]).trim());
  const noTradeSymbols = missingSymbols.filter(s => {
    const m = s.match(/^(.+)\.(TW|TWO)$/i);
    return !!m && (m[2].toUpperCase() === 'TWO' ? tpexAll : twseAll).has(m[1]);
  });
  const notInDailyTable = missingSymbols.filter(s => !noTradeSymbols.includes(s));

  // ^TWII 官方 OHLC 與市場成交量（兩個 TWSE OpenAPI），避免盤中 t00 快照當收盤。
  let indexRepaired = 0;
  const [{ data: indexRows }, { data: marketRows }] = await Promise.all([
    fetchJsonWithCurlFallback<Array<{ Date: string; OpeningIndex: string; HighestIndex: string; LowestIndex: string; ClosingIndex: string }>>(
      'https://openapi.twse.com.tw/v1/indicesReport/MI_5MINS_HIST', { timeoutMs: 20_000 }),
    fetchJsonWithCurlFallback<Array<{ Date: string; TradeVolume: string; TAIEX: string }>>(
      'https://openapi.twse.com.tw/v1/indicesReport/FMTQIK', { timeoutMs: 20_000 }),
  ]);
  const roc = `${Number(targetDate.slice(0, 4)) - 1911}${targetDate.slice(5, 7)}${targetDate.slice(8, 10)}`;
  const ir = indexRows.find(r => r.Date === roc);
  const vr = marketRows.find(r => r.Date === roc);
  if (ir && vr && Number(ir.ClosingIndex) > 0 && Number(vr.TradeVolume) > 0) {
    const bar: Candle = { date: targetDate, open: Number(ir.OpeningIndex), high: Number(ir.HighestIndex),
      low: Number(ir.LowestIndex), close: Number(ir.ClosingIndex), volume: Math.round(Number(vr.TradeVolume) / 1000) };
    const local = await readCandleFile('^TWII', 'TW');
    if (!sameBar(local?.candles.find(c => c.date === targetDate), bar, true)) {
      if (apply) await saveLocalCandles('^TWII', 'TW', [bar]);
      indexRepaired = 1;
    }
  } else {
    throw new Error(`^TWII 官方 ${targetDate} OHLCV 缺失`);
  }

  let remainingMismatch = 0;
  if (apply) {
    for (const file of (await fs.readdir(dir)).filter(f => f.endsWith('.json'))) {
      const symbol = file.slice(0, -5);
      const match = symbol.match(/^(.+)\.(TW|TWO)$/i);
      if (!match) continue;
      const row = match[2].toUpperCase() === 'TWO' ? cache.tpexBulk.get(match[1]) : cache.twseBulk.get(match[1]);
      if (!row) continue;
      const local = await readCandleFile(symbol, 'TW');
      if (!sameBar(local?.candles.find(c => c.date === targetDate), { date: targetDate, ...row }, true)) remainingMismatch++;
    }
  }
  return { officialActive, alreadyExact, repaired, missingOfficial, noTradeSymbols, notInDailyTable,
    indexRepaired, writeFailed, remainingMismatch, quarantinedGhosts: ghosts };
}

async function repairCn(): Promise<Summary> {
  const snapshotPath = path.join(root, 'data', `intraday-CN-${targetDate}.json`);
  const snapshot = JSON.parse(await fs.readFile(snapshotPath, 'utf8')) as {
    quotes?: Array<{ symbol: string; open: number; high: number; low: number; close: number; volume: number }>;
  };
  // 指數保留 suffix，避免 000001.SS（上證指數）撞 000001.SZ（平安銀行）。
  const quotes = new Map((snapshot.quotes ?? []).map(q => [q.symbol, q]));
  const dir = path.join(root, 'data', 'candles', 'CN');
  const files = (await fs.readdir(dir)).filter(f => f.endsWith('.json'));
  let comparable = 0, alreadyExact = 0, repaired = 0, noSnapshot = 0, deferredToQfq = 0, writeFailed = 0;
  const repairedSymbols: string[] = [];
  for (const file of files) {
    const symbol = file.slice(0, -5);
    const code = symbol.replace(/\.(SS|SZ)$/i, '');
    const quote = quotes.get(symbol) ?? quotes.get(code);
    if (!quote) { noSnapshot++; continue; }
    const local = await readCandleFile(symbol, 'CN');
    const actual = local?.candles.find(c => c.date === targetDate);
    if (!actual) { noSnapshot++; continue; }
    comparable++;
    const hlcSame = Math.abs(actual.high - quote.high) < 0.000001 &&
      Math.abs(actual.low - quote.low) < 0.000001 && Math.abs(actual.close - quote.close) < 0.000001;
    if (!hlcSame) { deferredToQfq++; continue; }
    if (Math.abs(actual.open - quote.open) < 0.000001) { alreadyExact++; continue; }
    const expectedBar: Candle = { ...actual, open: quote.open };
    if (apply) {
      try { await saveLocalCandles(symbol, 'CN', [expectedBar]); }
      catch (err) { writeFailed++; console.warn(`[CN] ${symbol}: ${(err as Error).message}`); continue; }
    }
    repaired++; repairedSymbols.push(symbol);
  }
  let remainingMismatch = 0;
  if (apply) {
    for (const symbol of repairedSymbols) {
      const code = symbol.replace(/\.(SS|SZ)$/i, '');
      const quote = quotes.get(symbol) ?? quotes.get(code);
      if (!quote) continue;
      if (quote.volume === 0 && quote.open === quote.high && quote.high === quote.low && quote.low === quote.close) continue;
      const local = await readCandleFile(symbol, 'CN');
      const actual = local?.candles.find(c => c.date === targetDate);
      if (!actual || !sameBar(actual, { date: targetDate, ...quote }, false)) remainingMismatch++;
    }
  }
  return { snapshotQuotes: quotes.size, comparable, alreadyExact, repaired, deferredToQfq, noSnapshot, writeFailed, remainingMismatch };
}

async function main() {
  const report: Record<string, unknown> = { generatedAt: new Date().toISOString(), targetDate, apply };
  if (marketArg === 'TW' || marketArg === 'ALL') report.TW = await repairTw();
  if (marketArg === 'CN' || marketArg === 'ALL') report.CN = await repairCn();
  console.log(JSON.stringify(report, null, 2));
  if (apply) {
    const reportDir = path.join(root, 'data', 'reports');
    await fs.mkdir(reportDir, { recursive: true });
    await fs.writeFile(path.join(reportDir, `repair-market-eod-${targetDate}.json`), JSON.stringify(report, null, 2));
  }
  const failed = Object.values(report).some(v => typeof v === 'object' && v &&
    (Number((v as Summary).writeFailed || 0) > 0 || Number((v as Summary).remainingMismatch || 0) > 0));
  if (failed) process.exitCode = 1;
}

main().catch(err => { console.error(err); process.exit(1); });
