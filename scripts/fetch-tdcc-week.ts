/**
 * 抓最新一週全市場大戶持股，存到 per-stock TDCC L1 檔
 *
 * 用法：
 *   npx tsx scripts/fetch-tdcc-week.ts                 # 抓所有股
 *   npx tsx scripts/fetch-tdcc-week.ts --symbols 2330,3661  # 只存指定股（其他 skip）
 *
 * 排程：每天傍晚自動跑（instrumentation.ts local-cron + vercel.json）；
 *       TDCC「週五分散表」週末才公布，固定週四會慢一週（route 對已有基準日自動 skip）
 */

import { config } from 'dotenv';
import { existsSync } from 'fs';
if (existsSync('.env.local')) config({ path: '.env.local' });
config();

import { fetchTdccLatestWeek } from '@/lib/datasource/TdccProvider';
import { appendTdccDay, readTdccStock } from '@/lib/chips/ChipStorage';

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

  console.log('📥 抓 TDCC 大戶持股最新一週...');
  const week = await fetchTdccLatestWeek();
  console.log(`✅ 取得 ${week.date} 全市場 ${week.data.size} 檔資料`);

  let saved = 0;
  let skipped = 0;
  for (const [code, row] of week.data) {
    if (filterSymbols && !filterSymbols.has(code)) continue;
    // 已有相同基準日 → skip（避免重複寫）
    const existing = await readTdccStock(code);
    if (existing?.lastDate === week.date) {
      skipped++;
      continue;
    }
    await appendTdccDay(code, week.date, row);
    saved++;
  }
  console.log(`\n🎉 完成 saved=${saved} skipped=${skipped}`);
}

main().catch(err => {
  console.error('❌ 失敗:', err);
  process.exit(1);
});
