/**
 * 一次性：把「最新一週」TDCC 全市場資料用新版 parser 重抓並覆蓋既有同日記錄，
 * 補上全 15 級距明細（brackets：每級人數+比例）。
 *
 * 為什麼需要：fetch-tdcc-week 對「已有相同基準日」的股會 skip（避免重複寫），
 * 所以舊版存進去、沒有 brackets 的最新一週記錄不會被自動補。這支不 skip、
 * 直接以同日覆蓋（appendTdccDay 依 date 去重，後者覆蓋；聚合 holder*Pct 算法不變、
 * 只是多帶 brackets），讓「集保持股分布」走圖表當週就能顯示完整 15 級距。
 *
 * 之後每出現「新的一週」，每日 cron（fetch-tdcc-week）就會自動帶 brackets，無需再跑。
 *
 * 用法：
 *   npx tsx scripts/refresh-tdcc-brackets-latest.ts                 # 全市場
 *   npx tsx scripts/refresh-tdcc-brackets-latest.ts --symbols 2330,1216  # 指定股
 */

import { config } from 'dotenv';
import { existsSync } from 'fs';
if (existsSync('.env.local')) config({ path: '.env.local' });
config();

import { fetchTdccLatestWeek } from '@/lib/datasource/TdccProvider';
import { appendTdccDay } from '@/lib/chips/ChipStorage';

async function main() {
  const args = process.argv.slice(2);
  let filterSymbols: Set<string> | null = null;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--symbols' && args[i + 1]) {
      filterSymbols = new Set(
        args[i + 1].split(',').map(s => s.trim().replace(/\.(TW|TWO)$/i, '')).filter(Boolean),
      );
      i++;
    }
  }

  console.log('📥 重抓 TDCC 最新一週（補全 15 級距 brackets）...');
  const week = await fetchTdccLatestWeek();
  const withBrackets = Array.from(week.data.values()).filter(d => d.brackets?.length).length;
  console.log(`✅ ${week.date} 全市場 ${week.data.size} 檔，其中 ${withBrackets} 檔有 brackets`);

  let saved = 0;
  for (const [code, row] of week.data) {
    if (filterSymbols && !filterSymbols.has(code)) continue;
    await appendTdccDay(code, week.date, row); // 不 skip：依 date 覆蓋，補上 brackets
    saved++;
    if (saved % 300 === 0) console.log(`  ...已覆蓋 ${saved} 檔`);
  }
  console.log(`\n🎉 完成 saved=${saved}（最新週 ${week.date} 已帶完整級距）`);
}

main().catch(err => { console.error('❌', err); process.exit(1); });
