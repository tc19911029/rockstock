/**
 * 修復上櫃 L1 近端污染根（2026-06-09 收尾）。
 *
 * 背景：06-08 盤後封存（在 .TWO 次檔位守衛部署前）對部分上櫃股寫進「中間價」假收盤，
 * 例如 2073=25.425(=25.40/25.45 中點)、2948 close 36.975(真 37.75)。audit-l1-invariant
 * 只查最新封存根，06-09 蓋上去後這些 06-08 污染根就永遠不會被複查 → 需手動清。
 *
 * 處理：掃所有 .TWO，找 06-08/06-09 有「次檔位 OHLC」的根，對該日打 FinMind：
 *   - FinMind 回合法檔位 bar → saveLocalCandles 覆蓋同日（writeCandleFile incoming wins）。
 *   - FinMind 回 0 / 無資料（當日沒交易）→ 直接從檔案刪掉該偽根、重算 lastDate。
 *   - FinMind 也非法檔位（罕見）→ 跳過並記錄，不亂動。
 *
 * FinMind-only、寫前 isValidTwTick 驗、限流。
 * 用法：npx tsx scripts/repair-twoo-tail.ts [--dry] [--delay 700]
 */
import { config } from 'dotenv';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'fs';
import path from 'path';

if (existsSync('.env.local')) config({ path: '.env.local' });
config();

import { saveLocalCandles } from '../lib/datasource/LocalCandleStore';
import { finmindHistProvider } from '../lib/datasource/FinMindHistProvider';
import { isValidTwTick, isTwEtf } from '../lib/datasource/twTick';

const DRY = process.argv.includes('--dry');
const di = process.argv.indexOf('--delay');
const DELAY = di >= 0 ? parseInt(process.argv[di + 1], 10) : 700;
const DATES = ['2026-06-08', '2026-06-09'];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Bar { date: string; open: number; high: number; low: number; close: number; volume: number }

function tickOk(c: Bar, etf: boolean) {
  return isValidTwTick(c.open, etf) && isValidTwTick(c.high, etf) &&
         isValidTwTick(c.low, etf) && isValidTwTick(c.close, etf);
}

async function main() {
  const dir = path.join(process.cwd(), 'data', 'candles', 'TW');
  // 1) 找污染：06-08/06-09 有非法檔位的 .TWO
  const contaminated: { sym: string; file: string; badDates: string[] }[] = [];
  for (const f of readdirSync(dir)) {
    if (!f.endsWith('.TWO.json')) continue;
    const sym = f.replace('.json', '');
    const etf = isTwEtf(sym);
    try {
      const j = JSON.parse(readFileSync(path.join(dir, f), 'utf8'));
      const bad: string[] = [];
      for (const c of (j.candles || []) as Bar[]) {
        if (!DATES.includes(c.date)) continue;
        if (!tickOk(c, etf)) bad.push(c.date);
      }
      if (bad.length) contaminated.push({ sym, file: path.join(dir, f), badDates: bad });
    } catch { /* skip */ }
  }
  console.log(`污染檔: ${contaminated.length}${DRY ? ' [DRY]' : ''}`);

  let overwritten = 0, deleted = 0, fmBad = 0, errs = 0;
  for (const { sym, file, badDates } of contaminated) {
    const etf = isTwEtf(sym);
    let fm: Bar[] = [];
    try {
      fm = await finmindHistProvider.getCandlesRange(sym, badDates[0], DATES[DATES.length - 1]) as Bar[];
    } catch (e) {
      errs++; console.warn(`  ${sym} FinMind 失敗: ${(e as Error).message}`); await sleep(DELAY); continue;
    }
    const fmByDate = new Map(fm.map((c) => [c.date, c]));

    const toOverwrite: Bar[] = [];
    const toDelete: string[] = [];
    for (const d of badDates) {
      const clean = fmByDate.get(d);
      if (clean && clean.close > 0) {
        if (tickOk(clean, etf)) toOverwrite.push(clean);
        else { fmBad++; console.warn(`  ${sym} ${d} FinMind 也非法檔位 C=${clean.close} → 跳過`); }
      } else {
        // FinMind 無此日（0/缺）→ 當日沒交易，刪偽根
        toDelete.push(d);
      }
    }

    if (toOverwrite.length && !DRY) {
      try { await saveLocalCandles(sym, 'TW', toOverwrite); } catch (e) { errs++; console.warn(`  ${sym} 覆蓋失敗: ${(e as Error).message}`); }
    }
    if (toDelete.length) {
      // 直接刪偽根（saveLocalCandles 不能刪同日）
      try {
        const j = JSON.parse(readFileSync(file, 'utf8'));
        const before = j.candles.length;
        j.candles = (j.candles as Bar[]).filter((c) => !toDelete.includes(c.date));
        j.lastDate = j.candles.length ? j.candles[j.candles.length - 1].date : j.lastDate;
        j.sealedDate = j.lastDate;
        if (!DRY) writeFileSync(file, JSON.stringify(j));
        console.log(`  ${sym} 刪偽根 ${toDelete.join(',')}（${before}→${j.candles.length}, lastDate→${j.lastDate}）`);
      } catch (e) { errs++; console.warn(`  ${sym} 刪除失敗: ${(e as Error).message}`); }
    }
    if (toOverwrite.length) { overwritten += toOverwrite.length; console.log(`  ${sym} 覆蓋 ${toOverwrite.map((c) => c.date + '=' + c.close).join(',')}`); }
    deleted += toDelete.length;
    await sleep(DELAY);
  }

  console.log('---');
  console.log(`完成：覆蓋 ${overwritten} 根；刪偽根 ${deleted} 根；FinMind非法 ${fmBad}；錯 ${errs}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
