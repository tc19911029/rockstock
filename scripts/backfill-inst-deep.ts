/**
 * 法人(三大法人買賣超) 深歷史回填 — 強制從 START 抓整段(不像 backfill-chips-tw 只往前補)
 * 用法：npx tsx scripts/backfill-inst-deep.ts [--from 2023-01-01] [--symbols 2330,2317]
 */
import { config } from 'dotenv';
import { existsSync, promises as fs } from 'fs';
import path from 'path';
if (existsSync('.env.local')) config({ path: '.env.local' });
config();

import { fetchT86ForStock } from '@/lib/datasource/TwseT86Provider';
import { writeInstStock } from '@/lib/chips/ChipStorage';
import { getLastTradingDay } from '@/lib/datasource/marketHours';

async function main() {
  const args = process.argv.slice(2);
  const from = args.includes('--from') ? args[args.indexOf('--from') + 1] : '2023-01-01';
  const symArg = args.includes('--symbols') ? args[args.indexOf('--symbols') + 1] : null;
  const end = getLastTradingDay('TW');

  let codes: string[];
  if (symArg) codes = symArg.split(',').map(s => s.trim());
  else codes = (await fs.readdir(path.join(process.cwd(), 'data/chips/TW/inst')))
    .filter(f => /^\d{4}\.json$/.test(f)).map(f => f.replace('.json', ''));

  console.log(`深回填法人 ${from} ~ ${end}，共 ${codes.length} 檔`);
  let ok = 0, fail = 0, done = 0;
  for (const code of codes) {
    try {
      const fetched = await fetchT86ForStock(code, from, end);
      if (fetched.size === 0) { console.log(`⏭  ${code} 0 筆`); done++; continue; }
      const rows = Array.from(fetched.entries()).map(([date, v]) => ({ date, ...v }));
      rows.sort((a, b) => a.date.localeCompare(b.date));
      await writeInstStock(code, rows);
      ok++; done++;
      if (done % 25 === 0 || done <= 3)
        console.log(`✅ [${done}/${codes.length}] ${code} ${rows.length} 筆 (${rows[0].date}~${rows[rows.length - 1].date})`);
      await new Promise(r => setTimeout(r, 1200)); // FinMind 限流
    } catch (e) {
      fail++; done++;
      console.error(`❌ ${code}`, e instanceof Error ? e.message : e);
      if (e instanceof Error && /Your level|status=402|status=429|402|429/i.test(e.message)) {
        console.error('🚫 FinMind 配額耗盡，停止（已完成的有效）'); break;
      }
    }
  }
  console.log(`完成 ok=${ok} fail=${fail}`);
}
main().catch(e => { console.error(e); process.exit(1); });
