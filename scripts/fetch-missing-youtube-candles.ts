/**
 * 對 5/18-5/22 youtube analysis 內所有提到的股票，
 * 檢查本地 data/candles/TW/{code}.TW.json 有沒有檔；缺的用 Yahoo Finance 補。
 *
 * 用法：npx tsx scripts/fetch-missing-youtube-candles.ts
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fetchCandlesYahoo } from '../lib/datasource/YahooFinanceDS';

const ANALYSIS_DIR = path.join(process.cwd(), 'data/youtube/analysis');
const CANDLE_DIR = path.join(process.cwd(), 'data/candles/TW');

async function gatherStockCodes(): Promise<Set<string>> {
  const codes = new Set<string>();
  const files = await fs.readdir(ANALYSIS_DIR);
  for (const f of files) {
    if (!/^2026-05-\d{2}\.json$/.test(f)) continue;
    const raw = await fs.readFile(path.join(ANALYSIS_DIR, f), 'utf-8');
    const data = JSON.parse(raw);
    for (const arr of [data.high_consensus_stocks ?? [], data.weak_signal_stocks ?? []]) {
      for (const m of arr) {
        if (m.matched?.code) codes.add(m.matched.code);
      }
    }
    for (const s of data.stock_scoring ?? []) {
      if (s.stock_code) codes.add(s.stock_code);
    }
  }
  return codes;
}

async function main() {
  const codes = await gatherStockCodes();
  console.log(`Total unique stocks across 5 days: ${codes.size}`);

  const missing: string[] = [];
  for (const code of codes) {
    const file = path.join(CANDLE_DIR, `${code}.TW.json`);
    try {
      await fs.access(file);
    } catch {
      missing.push(code);
    }
  }
  console.log(`Missing K-line files: ${missing.length}\n  ${missing.join(', ')}`);

  let okCount = 0;
  let failCount = 0;
  for (const code of missing) {
    process.stdout.write(`  ${code} ... `);
    try {
      // 試 .TW (上市)；失敗試 .TWO (上櫃)
      let candles = await fetchCandlesYahoo(`${code}.TW`, '5y', 30000).catch(() => null);
      let symbolUsed = `${code}.TW`;
      if (!candles || candles.length === 0) {
        candles = await fetchCandlesYahoo(`${code}.TWO`, '5y', 30000).catch(() => null);
        symbolUsed = `${code}.TWO`;
      }
      if (!candles || candles.length === 0) {
        console.log('NO DATA from Yahoo (both .TW and .TWO)');
        failCount++;
        continue;
      }
      // 儲存格式 = { symbol, candles: [...] }
      const stripped = candles.map(c => ({
        date: c.date, open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume,
      }));
      const payload = { symbol: `${code}.TW`, candles: stripped, source: symbolUsed, fetched_at: new Date().toISOString() };
      await fs.writeFile(path.join(CANDLE_DIR, `${code}.TW.json`), JSON.stringify(payload));
      console.log(`✓ (${stripped.length} candles via ${symbolUsed})`);
      okCount++;
      // 禮貌一下別打爆 Yahoo
      await new Promise(r => setTimeout(r, 800));
    } catch (err) {
      console.log(`✗ ${(err as Error).message}`);
      failCount++;
    }
  }

  console.log(`\nDone: ${okCount} ok, ${failCount} fail`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
