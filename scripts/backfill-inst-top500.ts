#!/usr/bin/env npx tsx
/**
 * backfill-inst-top500.ts — 把「成交額前 500」的三大法人(T86)資料補齊／更新到最新交易日。
 *
 * 背景（2026-06-15）：大戶法人偷買(Y)軌原本池子＝broker∩inst（只 ~395 檔，受三大法人覆蓋限制），
 * 跟 W/X 軌「成交額前 500」不一致。使用者要求對齊前 500 → 先補齊前 500 的三大法人。
 * 券商分點前 500 已全有；缺的只有三大法人（~183 檔）。
 *
 * 用法：npx tsx scripts/backfill-inst-top500.ts [--missing-only]
 */
import { config } from 'dotenv';
config({ path: '.env.local' });

import { promises as fs } from 'fs';
import path from 'path';
import { fetchT86ForStock } from '@/lib/datasource/TwseT86Provider';
import { readInstStock, writeInstStock } from '@/lib/chips/ChipStorage';
import { getLastTradingDay } from '@/lib/datasource/marketHours';

function dateMinusDays(date: string, days: number): string {
  const d = new Date(date + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

async function main() {
  const missingOnly = process.argv.includes('--missing-only');
  const target = getLastTradingDay('TW');
  const top500: string[] = JSON.parse(
    await fs.readFile(path.join(process.cwd(), 'data/turnover-rank/TW.json'), 'utf8'),
  ).symbols.map((s: string) => s.split('.')[0]);

  // 決定每檔的抓取起點：已有資料 → 從 lastDate 增量；沒有 → 回補 200 日
  const jobs: { code: string; start: string }[] = [];
  for (const code of top500) {
    const ex = await readInstStock(code);
    if (ex && ex.lastDate >= target) continue;        // 已是最新 → 跳過
    if (missingOnly && ex) continue;                  // 只補完全沒有的
    jobs.push({ code, start: ex?.lastDate ? dateMinusDays(ex.lastDate, -1) : dateMinusDays(target, 200) });
  }
  console.log(`前 500 檔，需補/更新三大法人 ${jobs.length} 檔（目標日 ${target}）`);

  let ok = 0, empty = 0, fail = 0, done = 0;
  const CONC = 5;
  for (let i = 0; i < jobs.length; i += CONC) {
    await Promise.all(jobs.slice(i, i + CONC).map(async ({ code, start }) => {
      try {
        const fetched = await fetchT86ForStock(code, start, target);
        if (fetched.size > 0) {
          await writeInstStock(code, Array.from(fetched.entries()).map(([date, v]) => ({ date, ...v })));
          ok++;
        } else empty++;
      } catch { fail++; }
    }));
    done += jobs.slice(i, i + CONC).length;
    if (done % 50 === 0 || done >= jobs.length) console.log(`  ${done}/${jobs.length} ok=${ok} empty=${empty} fail=${fail}`);
  }
  console.log(`完成：寫入 ${ok}、無資料 ${empty}、失敗 ${fail}`);
}

main();
