/**
 * 補完「卡在舊日的上櫃股」到目標日 — FinMind-only、驗檔位、append-only。
 *
 * 針對 lastDate <= cutoff 的 .TWO（2026-06-09 收尾時是原 124 檔卡 06-05 的殘餘），
 * 抓 FinMind 區間補到 target。FinMind 配額（402）爆掉就停、印出還剩幾檔，等下個配額窗再跑。
 * 與 backfill-twoo-finmind-seal 的差別：用 cutoff 精準鎖定「嚴重落後」那批，不掃整個市場
 * （避免一次打 ~750 檔再爆配額）。
 *
 * 用法：npx tsx scripts/backfill-twoo-stuck.ts [--cutoff 2026-06-05] [--target 2026-06-09] [--delay 700]
 */
import { config } from 'dotenv';
import { existsSync, readdirSync, readFileSync } from 'fs';
import path from 'path';

if (existsSync('.env.local')) config({ path: '.env.local' });
config();

import { saveLocalCandles } from '../lib/datasource/LocalCandleStore';
import { finmindHistProvider } from '../lib/datasource/FinMindHistProvider';
import { isValidTwTick, isTwEtf } from '../lib/datasource/twTick';

function arg(name: string, def: string): string {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : def;
}
const CUTOFF = arg('--cutoff', '2026-06-05');
const TARGET = arg('--target', '2026-06-09');
const DELAY = parseInt(arg('--delay', '700'), 10);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const dir = path.join(process.cwd(), 'data', 'candles', 'TW');
  const stuck: { sym: string; last: string }[] = [];
  for (const f of readdirSync(dir)) {
    if (!f.endsWith('.TWO.json')) continue;
    try {
      const j = JSON.parse(readFileSync(path.join(dir, f), 'utf8'));
      if (j.lastDate <= CUTOFF) stuck.push({ sym: f.replace('.json', ''), last: j.lastDate });
    } catch { /* skip */ }
  }
  console.log(`卡 ≤${CUTOFF} 的上櫃：${stuck.length} 檔 → 補到 ${TARGET}`);

  let wrote = 0, bars = 0, noTrade = 0, errs = 0, quotaHit = false;
  for (const { sym, last } of stuck) {
    if (quotaHit) { errs++; continue; }
    const etf = isTwEtf(sym);
    let fm: { date: string; open: number; high: number; low: number; close: number; volume: number }[] = [];
    let failed = false;
    for (let a = 0; a < 3; a++) {
      try { fm = await finmindHistProvider.getCandlesRange(sym, last, TARGET); break; }
      catch (e) {
        const msg = (e as Error).message;
        if (/circuit breaker|402/.test(msg)) { quotaHit = true; failed = true; console.warn(`  ⛔ ${sym}: FinMind 配額熔斷，停止（剩餘等下個窗）`); break; }
        if (a === 2) { errs++; failed = true; console.warn(`  ${sym} err: ${msg}`); }
        else await sleep(1000 * (a + 1));
      }
    }
    if (failed) { await sleep(DELAY); continue; }
    const fresh = fm.filter((c) => c.date > last && c.date <= TARGET);
    if (!fresh.length) { noTrade++; await sleep(DELAY); continue; }
    const clean = fresh.filter((c) => isValidTwTick(c.open, etf) && isValidTwTick(c.high, etf) && isValidTwTick(c.low, etf) && isValidTwTick(c.close, etf));
    if (!clean.length) { await sleep(DELAY); continue; }
    try { await saveLocalCandles(sym, 'TW', clean); wrote++; bars += clean.length; console.log(`  ${sym} +[${clean.map((c) => c.date + '=' + c.close).join(', ')}]`); }
    catch (e) { errs++; console.warn(`  ${sym} save: ${(e as Error).message}`); }
    await sleep(DELAY);
  }
  console.log('---');
  console.log(`寫 ${wrote} 檔 / ${bars} 根；無新交易 ${noTrade}；錯/配額卡 ${errs}${quotaHit ? '（配額爆，未完，請等配額窗重跑）' : ''}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
