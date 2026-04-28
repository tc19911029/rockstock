/**
 * 補抓「漏 04/27」但已有 04/28 的 79 支
 *
 * 原因：先前 update-intraday cron 在 14:00 寫入 04/28，
 * 之後跑的 repair-tw-0427-0428 用 last<target 判斷已 skip。
 * 改為：明確查 4/27 是否在 candles[]，缺就補。
 */
import { config } from 'dotenv';
import { existsSync } from 'fs';
if (existsSync('.env.local')) config({ path: '.env.local' });
config();

import { promises as fs } from 'fs';
import path from 'path';
import { writeCandleFile } from '../lib/datasource/CandleStorageAdapter';

const MISSING_DATE = '2026-04-27';
const CONCURRENCY = 6;
const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

async function fetchYahoo(symbol: string): Promise<{ date: string; open: number; high: number; low: number; close: number; volume: number }[]> {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?interval=1d&range=10d`;
  const res = await fetch(url, { signal: AbortSignal.timeout(10000), headers: { 'User-Agent': 'Mozilla/5.0' } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const json = await res.json() as { chart?: { result?: { timestamp?: number[]; indicators: { quote: { open: (number|null)[]; high: (number|null)[]; low: (number|null)[]; close: (number|null)[]; volume: (number|null)[] }[] } }[] } };
  const r = json.chart?.result?.[0];
  const ts = r?.timestamp;
  if (!ts) return [];
  const q = r.indicators.quote[0];
  const out: { date: string; open: number; high: number; low: number; close: number; volume: number }[] = [];
  for (let i = 0; i < ts.length; i++) {
    const close = q.close[i];
    if (close == null || close <= 0) continue;
    const date = new Date(ts[i] * 1000).toISOString().slice(0, 10);
    out.push({
      date,
      open: q.open[i] ?? close,
      high: q.high[i] ?? close,
      low: q.low[i] ?? close,
      close,
      volume: Math.round((q.volume[i] ?? 0) / 1000),
    });
  }
  return out;
}

async function findMissing(): Promise<string[]> {
  const dir = path.join('data', 'candles', 'TW');
  const files = await fs.readdir(dir);
  const out: string[] = [];
  for (const f of files) {
    if (!f.endsWith('.json')) continue;
    try {
      const j = JSON.parse(await fs.readFile(path.join(dir, f), 'utf8')) as { candles: { date: string }[] };
      if (!j.candles?.length) continue;
      const dates = new Set(j.candles.map(c => c.date));
      // 已有 04/28 但缺 04/27
      if (dates.has('2026-04-28') && !dates.has(MISSING_DATE)) {
        out.push(f.replace('.json', ''));
      }
    } catch {}
  }
  return out;
}

async function main() {
  const missing = await findMissing();
  console.log(`🔍 ${missing.length} 支缺 ${MISSING_DATE}\n`);

  let ok = 0, fail = 0, noTargetDate = 0;
  for (let i = 0; i < missing.length; i += CONCURRENCY) {
    const batch = missing.slice(i, i + CONCURRENCY);
    await Promise.allSettled(batch.map(async (symbol) => {
      try {
        const rows = await fetchYahoo(symbol);
        const targetRow = rows.find(r => r.date === MISSING_DATE);
        if (!targetRow) { noTargetDate++; return; }
        await writeCandleFile(symbol, 'TW', [targetRow]);
        ok++;
      } catch {
        fail++;
      }
    }));
    if ((i / CONCURRENCY) % 5 === 0) {
      const pct = Math.round((i + CONCURRENCY) / missing.length * 100);
      process.stdout.write(`\r   ${Math.min(100, pct)}% ok=${ok} noTarget=${noTargetDate} fail=${fail}`);
    }
    await sleep(300);
  }
  console.log(`\n\n✅ ok=${ok} noTarget=${noTargetDate} fail=${fail}`);
}

main().catch(e => { console.error(e); process.exit(1); });
