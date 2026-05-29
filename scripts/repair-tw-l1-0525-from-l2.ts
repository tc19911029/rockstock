/**
 * repair-tw-l1-0525-from-l2.ts
 *
 * 0525 cron 對 20 檔上櫃股 ghost .TW 寫進了「前一交易日的 OHLC」(stale source)。
 * 全市場 audit 後另有 ~58 檔 .TWO 跟 L2 0525 偏差 > 0.5%。
 *
 * 對所有 L1 0525 close 跟 L2 0525 close 偏差 > 0.5% 的，用 L2 OHLC 覆寫 L1 0525 那根 candle。
 * 走 saveLocalCandles → writeCandleFile merge 路徑，同日會覆蓋 existing，保留歷史 K 棒。
 *
 * 用法：
 *   npx tsx scripts/repair-tw-l1-0525-from-l2.ts            # dry-run
 *   npx tsx scripts/repair-tw-l1-0525-from-l2.ts --apply    # 真寫
 */
import { config } from 'dotenv';
import { existsSync } from 'fs';
if (existsSync('.env.local')) config({ path: '.env.local' });
config();

import { readFile, readdir } from 'fs/promises';
import path from 'path';
import { readCandleFile } from '../lib/datasource/CandleStorageAdapter';
import { saveLocalCandles } from '../lib/datasource/LocalCandleStore';
import type { Candle } from '../types';

const TARGET_DATE = '2026-05-25';
const DIFF_THRESHOLD_PCT = 0.5;

interface L2Quote {
  symbol: string; name: string;
  open: number; high: number; low: number; close: number;
  volume: number; prevClose: number; changePercent: number;
}

async function loadL2(date: string): Promise<Map<string, L2Quote>> {
  const raw = await readFile(path.join(process.cwd(), `data/intraday-TW-${date}.json`), 'utf-8');
  const snap = JSON.parse(raw) as { quotes: L2Quote[] };
  return new Map(snap.quotes.map(q => [q.symbol, q]));
}

async function main() {
  const apply = process.argv.includes('--apply');
  const mode = apply ? 'APPLY' : 'DRY-RUN';
  console.log(`[repair] mode=${mode} target=${TARGET_DATE} threshold=${DIFF_THRESHOLD_PCT}%`);

  const l2 = await loadL2(TARGET_DATE);
  console.log(`[repair] L2 ${TARGET_DATE}: ${l2.size} quotes`);

  const files = await readdir('data/candles/TW');
  const l1Files = files.filter(f => /^\d{4,6}[A-Z]?\.(TW|TWO)\.json$/.test(f));
  const fileSet = new Set(files);
  console.log(`[repair] scanning ${l1Files.length} L1 files...`);

  type RepairItem = {
    symbolWithSuffix: string;
    code: string;
    suffix: 'TW' | 'TWO';
    existingClose: number;
    target: L2Quote;
    diffPct: number;
    ghost: boolean;
  };
  const repairs: RepairItem[] = [];
  let scanned = 0, missing0525 = 0, noL2 = 0, inSpec = 0;

  for (const fn of l1Files) {
    scanned++;
    const sym = fn.replace(/\.json$/, '');
    const [code, suffix] = sym.split('.') as [string, 'TW' | 'TWO'];
    const data = await readCandleFile(sym, 'TW');
    if (!data) continue;
    const c0525 = data.candles.find(c => c.date === TARGET_DATE);
    if (!c0525) { missing0525++; continue; }
    const l2q = l2.get(code);
    if (!l2q) { noL2++; continue; }
    const diffPct = Math.abs(c0525.close - l2q.close) / l2q.close * 100;
    if (diffPct < DIFF_THRESHOLD_PCT) { inSpec++; continue; }
    const otherSuffix = suffix === 'TW' ? 'TWO' : 'TW';
    const ghost = fileSet.has(`${code}.${otherSuffix}.json`);
    repairs.push({ symbolWithSuffix: sym, code, suffix, existingClose: c0525.close, target: l2q, diffPct, ghost });
  }

  console.log(
    `[repair] scanned=${scanned} missing-0525=${missing0525} no-L2=${noL2} in-spec=${inSpec} to-repair=${repairs.length}`
  );
  repairs.sort((a, b) => b.diffPct - a.diffPct);
  for (const r of repairs) {
    const ghostTag = r.ghost ? '[ghost]' : '       ';
    console.log(
      `${ghostTag} ${r.symbolWithSuffix.padEnd(12)} L1c=${String(r.existingClose).padStart(8)} → L2 ` +
      `O=${r.target.open} H=${r.target.high} L=${r.target.low} C=${r.target.close} V=${r.target.volume} ` +
      `(diff ${r.diffPct.toFixed(2)}%)`
    );
  }

  if (!apply) {
    console.log('\n[repair] DRY-RUN — pass --apply to actually write');
    return;
  }

  console.log('\n[repair] APPLY — writing...');
  let ok = 0, fail = 0;
  for (const r of repairs) {
    const newBar: Candle = {
      date: TARGET_DATE,
      open: r.target.open,
      high: r.target.high,
      low: r.target.low,
      close: r.target.close,
      volume: r.target.volume,
    };
    try {
      await saveLocalCandles(r.symbolWithSuffix, 'TW', [newBar]);
      ok++;
    } catch (err) {
      fail++;
      console.error(`  ✗ ${r.symbolWithSuffix}:`, err instanceof Error ? err.message : err);
    }
  }
  console.log(`[repair] DONE — ok=${ok} fail=${fail}`);
}

main().catch(err => { console.error(err); process.exit(1); });
