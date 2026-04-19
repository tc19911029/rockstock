/**
 * 補抓 TWSE 三大法人買賣超歷史資料
 *
 * 用法：
 *   npx tsx scripts/fetch-twse-institutional.ts            # 近 30 個交易日
 *   npx tsx scripts/fetch-twse-institutional.ts --days 10  # 近 10 個
 *   npx tsx scripts/fetch-twse-institutional.ts --date 2026-04-17  # 單日
 */
import { config } from 'dotenv';
config({ path: '.env.local' });
config();

import { fetchTWSEInstitutional } from '../lib/datasource/TWSEInstitutional';
import { saveInstitutionalTW, readInstitutionalTW } from '../lib/storage/institutionalStorage';
import { isTradingDay } from '../lib/utils/tradingDay';

function listRecentTradingDays(count: number): string[] {
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Taipei' }).format(new Date());
  const results: string[] = [];
  const cursor = new Date(today + 'T00:00:00Z');
  while (results.length < count) {
    const iso = cursor.toISOString().slice(0, 10);
    if (isTradingDay(iso, 'TW')) results.push(iso);
    cursor.setUTCDate(cursor.getUTCDate() - 1);
  }
  return results.reverse();
}

async function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

async function main() {
  const args = process.argv.slice(2);
  let days = 30;
  let onlyDate: string | null = null;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--days' && args[i + 1]) { days = parseInt(args[i + 1], 10); i++; }
    if (args[i] === '--date' && args[i + 1]) { onlyDate = args[i + 1]; i++; }
  }

  const dates = onlyDate ? [onlyDate] : listRecentTradingDays(days);
  console.log(`\n🏦 抓 TWSE 三大法人 ${dates.length} 天: ${dates[0]} ~ ${dates[dates.length - 1]}`);

  let ok = 0, skip = 0, fail = 0;
  for (const date of dates) {
    if (!isTradingDay(date, 'TW')) { skip++; continue; }
    // 已有就跳過（避免 rate limit）
    const existing = await readInstitutionalTW(date);
    if (existing && existing.length > 0) {
      console.log(`⏭️  ${date} 已存在 (${existing.length} 筆)`);
      ok++;
      continue;
    }
    try {
      const records = await fetchTWSEInstitutional(date);
      if (records.length === 0) { console.log(`⚠️  ${date} 空資料（可能非交易日）`); skip++; }
      else {
        await saveInstitutionalTW(date, records);
        console.log(`✅ ${date} 儲存 ${records.length} 筆`);
        ok++;
      }
    } catch (err) {
      console.error(`❌ ${date} 失敗:`, err instanceof Error ? err.message : err);
      fail++;
    }
    // TWSE 禮貌延遲
    await sleep(1000);
  }

  console.log(`\n🎉 完成：ok=${ok} skip=${skip} fail=${fail}`);
}

main().catch(err => { console.error(err); process.exit(1); });
