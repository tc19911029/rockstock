/**
 * CN 最後一輪：用 Yahoo 補抓 Tencent/EastMoney 都搞不定的剩餘缺漏
 */
import { config } from 'dotenv';
import { existsSync } from 'fs';
if (existsSync('.env.local')) config({ path: '.env.local' });
config();

import { promises as fs } from 'fs';
import path from 'path';
import { writeCandleFile } from '../lib/datasource/CandleStorageAdapter';

const RECENT = ['2026-04-15','2026-04-16','2026-04-17','2026-04-20','2026-04-21','2026-04-22','2026-04-23','2026-04-24','2026-04-27','2026-04-28'];
const CONCURRENCY = 5;
const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

async function fetchYahoo(symbol: string) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?interval=1d&range=15d`;
  const res = await fetch(url, { signal: AbortSignal.timeout(10000), headers: { 'User-Agent': 'Mozilla/5.0' } });
  if (!res.ok) return [];
  const json = await res.json() as { chart?: { result?: { timestamp?: number[]; indicators: { quote: { open: (number|null)[]; high: (number|null)[]; low: (number|null)[]; close: (number|null)[]; volume: (number|null)[] }[] } }[] } };
  const r = json.chart?.result?.[0];
  const ts = r?.timestamp;
  if (!ts) return [];
  const q = r.indicators.quote[0];
  const out: { date: string; open: number; high: number; low: number; close: number; volume: number }[] = [];
  for (let i = 0; i < ts.length; i++) {
    const close = q.close[i];
    if (close == null || close <= 0) continue;
    out.push({
      date: new Date(ts[i] * 1000).toISOString().slice(0, 10),
      open: q.open[i] ?? close,
      high: q.high[i] ?? close,
      low: q.low[i] ?? close,
      close,
      volume: Math.round((q.volume[i] ?? 0) / 100), // CN 股→手（÷100）
    });
  }
  return out;
}

async function findGaps(): Promise<string[]> {
  const dir = path.join('data', 'candles', 'CN');
  const files = await fs.readdir(dir);
  const out: string[] = [];
  for (const f of files) {
    if (!f.endsWith('.json')) continue;
    try {
      const j = JSON.parse(await fs.readFile(path.join(dir, f), 'utf8')) as { candles: { date: string }[] };
      if (!j.candles?.length) continue;
      const dates = new Set(j.candles.slice(-30).map(c => c.date));
      const missing = RECENT.filter(d => !dates.has(d));
      if (missing.length > 0) out.push(f.replace('.json', ''));
    } catch {}
  }
  return out;
}

async function main() {
  const gaps = await findGaps();
  console.log(`🔍 ${gaps.length} 支 CN 仍有缺漏\n`);

  let ok = 0, noData = 0, fail = 0;
  for (let i = 0; i < gaps.length; i += CONCURRENCY) {
    const batch = gaps.slice(i, i + CONCURRENCY);
    await Promise.allSettled(batch.map(async (sym) => {
      try {
        const rows = await fetchYahoo(sym);
        const missing = rows.filter(r => RECENT.includes(r.date));
        if (missing.length === 0) { noData++; return; }
        await writeCandleFile(sym, 'CN', missing);
        ok++;
      } catch {
        fail++;
      }
    }));
    if ((i / CONCURRENCY) % 3 === 0) {
      const pct = Math.round((i + CONCURRENCY) / gaps.length * 100);
      process.stdout.write(`\r   ${Math.min(100, pct)}% ok=${ok} noData=${noData} fail=${fail}`);
    }
    await sleep(400);
  }
  console.log(`\n\n✅ ok=${ok} noData=${noData} fail=${fail}`);
}

main().catch(e => { console.error(e); process.exit(1); });
