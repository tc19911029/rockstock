/**
 * 受控補檔：上櫃(.TWO) 缺最近交易日的根 — FinMind-only 順序抓。
 *
 * 為何不用 backfill-tw-l1-multi-source：那支走 MultiMarketProvider 的 racing fallback，
 * FinMind 在併發 burst 下會回 400（限流）→ 落到 Yahoo/EODHD 中間價 → 次檔位偽價污染。
 * 本支只打 FinMind（單位轉換已正確：max→high / min→low / Trading_Volume÷1000 股→張），
 * 順序呼叫避開限流，寫前用 isValidTwTick 驗檔位，非法則跳過不寫（寧缺勿錯）。
 *
 * append-only：只寫 lastDate 之後、≤ targetDate 的根，不動已封存的根（符合 L1 不可覆寫鐵則）。
 *
 * 用法：
 *   npx tsx scripts/backfill-twoo-finmind-seal.ts --date 2026-06-09 [--dry] [--limit N]
 */
import { config } from 'dotenv';
import { existsSync, readdirSync, readFileSync } from 'fs';
import path from 'path';

if (existsSync('.env.local')) config({ path: '.env.local' });
config();

import { saveLocalCandles } from '../lib/datasource/LocalCandleStore';
import { finmindHistProvider } from '../lib/datasource/FinMindHistProvider';
import { isValidTwTick, isTwEtf } from '../lib/datasource/twTick';

function arg(name: string, def?: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : def;
}
const TARGET = arg('--date', '2026-06-09')!;
const DRY = process.argv.includes('--dry');
const LIMIT = parseInt(arg('--limit', '') ?? '', 10) || Infinity;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const dir = path.join(process.cwd(), 'data', 'candles', 'TW');
  const todo: { sym: string; lastDate: string }[] = [];
  for (const f of readdirSync(dir)) {
    if (!f.endsWith('.TWO.json')) continue; // 只處理上櫃
    const sym = f.replace('.json', '');
    try {
      const j = JSON.parse(readFileSync(path.join(dir, f), 'utf8'));
      const candles = j.candles || [];
      if (!candles.length) continue;
      const lastDate = candles[candles.length - 1].date;
      if (lastDate < TARGET) todo.push({ sym, lastDate });
    } catch {
      /* skip unreadable */
    }
    if (todo.length >= LIMIT) break;
  }
  console.log(`待補 ${todo.length} 檔上櫃（lastDate < ${TARGET}）${DRY ? ' [DRY]' : ''}`);

  let wrote = 0, bars = 0, missing = 0, badtick = 0, errs = 0;
  for (let i = 0; i < todo.length; i++) {
    const { sym, lastDate } = todo[i];
    let candles: Awaited<ReturnType<typeof finmindHistProvider.getCandlesRange>> = [];
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        candles = await finmindHistProvider.getCandlesRange(sym, lastDate, TARGET);
        break;
      } catch (e) {
        if (attempt === 2) { errs++; console.warn(`  ${sym} fetch 失敗: ${(e as Error).message}`); }
        else await sleep(800 * (attempt + 1));
      }
    }
    const etf = isTwEtf(sym);
    const fresh = candles.filter((c) => c.date > lastDate && c.date <= TARGET);
    if (!fresh.length) { missing++; await sleep(120); continue; }

    const clean = fresh.filter((c) => {
      const ok = isValidTwTick(c.open, etf) && isValidTwTick(c.high, etf) &&
                 isValidTwTick(c.low, etf) && isValidTwTick(c.close, etf);
      if (!ok) { badtick++; console.warn(`  ${sym} ${c.date} 次檔位跳過 O=${c.open} H=${c.high} L=${c.low} C=${c.close}`); }
      return ok;
    });
    if (!clean.length) { await sleep(120); continue; }

    if (!DRY) {
      try { await saveLocalCandles(sym, 'TW', clean); }
      catch (e) { errs++; console.warn(`  ${sym} 寫入失敗: ${(e as Error).message}`); await sleep(120); continue; }
    }
    wrote++; bars += clean.length;
    if (wrote <= 8 || wrote % 50 === 0) {
      console.log(`  ${wrote}: ${sym} +[${clean.map((c) => c.date + '=' + c.close).join(', ')}]`);
    }
    await sleep(150);
    if ((i + 1) % 100 === 0) {
      console.log(`進度 ${i + 1}/${todo.length}（寫 ${wrote}檔/${bars}根, 缺 ${missing}, 次檔位 ${badtick}, 錯 ${errs}）`);
    }
  }

  console.log('---');
  console.log(`完成：寫 ${wrote} 檔 / ${bars} 根；缺(FinMind無此日) ${missing}；次檔位跳過 ${badtick}；錯 ${errs}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
