/**
 * 預熱 TW 三大法人 L1 cache（per-stock）
 *
 * 預設：把使用者持倉 + 自選股 + 最新一天的 scan 結果先抓回來。
 * 也可指定股票代碼列表。
 *
 * 用法:
 *   npx tsx scripts/backfill-chips-tw.ts                                    # 預熱常用股
 *   npx tsx scripts/backfill-chips-tw.ts --symbols 2330,3661,6488           # 指定
 *   npx tsx scripts/backfill-chips-tw.ts --days 200                          # 抓多少天
 */

import { config } from 'dotenv';
import { existsSync } from 'fs';
if (existsSync('.env.local')) config({ path: '.env.local' });
config();

import { fetchT86ForStock } from '@/lib/datasource/TwseT86Provider';
import { writeInstStock, readInstStock } from '@/lib/chips/ChipStorage';
import { getLastTradingDay } from '@/lib/datasource/marketHours';

function dateMinusDays(date: string, days: number): string {
  const d = new Date(date + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

async function backfillOne(code: string, startDate: string, endDate: string): Promise<number> {
  const fetched = await fetchT86ForStock(code, startDate, endDate);
  if (fetched.size === 0) return 0;
  const rows = Array.from(fetched.entries()).map(([date, v]) => ({ date, ...v }));
  await writeInstStock(code, rows);
  return rows.length;
}

async function main() {
  const args = process.argv.slice(2);
  let symbolsArg: string | null = null;
  let days = 200;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--symbols' && args[i + 1]) { symbolsArg = args[i + 1]; i++; }
    if (args[i] === '--days' && args[i + 1]) { days = parseInt(args[i + 1], 10); i++; }
  }

  const targetDate = getLastTradingDay('TW');
  const startDate = dateMinusDays(targetDate, days);

  // 取目標股票列表
  let symbols: string[] = [];
  if (symbolsArg) {
    symbols = symbolsArg.split(',').map(s => s.trim().replace(/\.(TW|TWO)$/i, '')).filter(Boolean);
  } else {
    // 預設：常用股 + 大盤指標股（避免依賴 store/scan 資料來源）
    symbols = [
      '2330', '2317', '2454', '2308', '2382',  // 大型權值
      '3661', '6488', '3037', '4906',           // 上櫃熱門
      '2603', '2609', '2615',                    // 海運
      '2880', '2881', '2882', '2885',            // 金融
    ];
  }

  console.log(`📅 backfill T86 法人買賣超`);
  console.log(`   區間：${startDate} ~ ${targetDate}`);
  console.log(`   股票：${symbols.length} 支`);

  let ok = 0, skip = 0, fail = 0;
  for (const code of symbols) {
    const existing = await readInstStock(code);
    if (existing && existing.lastDate >= targetDate) {
      console.log(`⏭  ${code}  已最新 (${existing.data.length} 筆)`);
      skip++;
      continue;
    }
    try {
      const fetchStart = existing?.lastDate ? dateMinusDays(existing.lastDate, -1) : startDate;
      const n = await backfillOne(code, fetchStart, targetDate);
      console.log(`✅  ${code}  +${n} 筆`);
      ok++;
      // FinMind rate limit：每秒 1 query，保險每 1.2 秒
      await new Promise(r => setTimeout(r, 1200));
    } catch (err) {
      console.error(`❌  ${code}  失敗: ${err instanceof Error ? err.message : err}`);
      fail++;
      // 配額錯誤就停
      if (err instanceof Error && /Your level|status=402|status=429/i.test(err.message)) {
        console.error('🚫 FinMind 配額耗盡，停止');
        break;
      }
    }
  }

  console.log(`\n🎉 完成 ok=${ok} skip=${skip} fail=${fail}`);
}

main().catch(err => {
  console.error('❌ 致命錯誤:', err);
  process.exit(1);
});
