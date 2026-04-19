/**
 * 重跑過去 N 個交易日的 L4 掃描，套用 server 端目前的 active strategy。
 *
 * 特色：
 *   - 讀 server-side active strategy（/api/strategy/active 同步後的 ID）
 *   - 每天用「當天的」前 500 成交額（computeTurnoverRankAsOfDate），
 *     避免用今天的前 500 去掃歷史日期造成時光穿越
 *   - force=true 直接覆蓋舊 session
 *
 * 用法：
 *   npx tsx scripts/rescan-history.ts
 *   npx tsx scripts/rescan-history.ts --market TW
 *   npx tsx scripts/rescan-history.ts --days 20
 */

import { config } from 'dotenv';
import { existsSync, readdirSync } from 'fs';
if (existsSync('.env.local')) config({ path: '.env.local' });
config();

import { runScanPipeline } from '../lib/scanner/ScanPipeline';
import { isTradingDay } from '../lib/utils/tradingDay';
import { getActiveStrategyServer } from '../lib/strategy/activeStrategyServer';
import { computeTurnoverRankAsOfDate } from '../lib/scanner/TurnoverRank';
import { TaiwanScanner } from '../lib/scanner/TaiwanScanner';
import { ChinaScanner } from '../lib/scanner/ChinaScanner';
import path from 'path';

const DATA_DIR = path.join(process.cwd(), 'data');
void DATA_DIR;
void readdirSync;

// 從今天往回列 N 個交易日（包含今天若是交易日）
function listRecentTradingDays(market: 'TW' | 'CN', count: number): string[] {
  const tz = market === 'TW' ? 'Asia/Taipei' : 'Asia/Shanghai';
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(new Date());
  const results: string[] = [];
  const cursor = new Date(today + 'T00:00:00Z');
  while (results.length < count) {
    const iso = cursor.toISOString().slice(0, 10);
    if (isTradingDay(iso, market)) results.push(iso);
    cursor.setUTCDate(cursor.getUTCDate() - 1);
  }
  return results.reverse(); // 舊→新
}

async function main() {
  const args = process.argv.slice(2);
  const markets: ('TW' | 'CN')[] = [];
  let maxDays = 30;
  let onlyDate: string | null = null;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--market' && args[i + 1]) {
      const m = args[i + 1].toUpperCase();
      if (m === 'TW' || m === 'CN') markets.push(m as 'TW' | 'CN');
      i++;
    } else if (args[i] === '--days' && args[i + 1]) {
      maxDays = parseInt(args[i + 1], 10);
      i++;
    } else if (args[i] === '--date' && args[i + 1]) {
      onlyDate = args[i + 1];
      i++;
    }
  }

  const targetMarkets: ('TW' | 'CN')[] = markets.length > 0 ? markets : ['TW', 'CN'];

  // 讀 server 端目前的策略（UI 若已切換過，這裡會拿到新策略）
  const activeStrategy = await getActiveStrategyServer();

  console.log(`\n🔄 重跑歷史 L4 掃描 — ${new Date().toISOString()}`);
  console.log(`   市場: ${targetMarkets.join(', ')}, 最多 ${maxDays} 天`);
  console.log(`   策略: ${activeStrategy.id} (${activeStrategy.name})`);
  console.log(`   門檻: 量比≥${activeStrategy.thresholds.volumeRatioMin}, KD≤${activeStrategy.thresholds.kdMaxEntry}, 乖離≤${activeStrategy.thresholds.deviationMax}`);

  for (const market of targetMarkets) {
    let dates = listRecentTradingDays(market, maxDays);
    if (onlyDate) dates = dates.filter(d => d === onlyDate);
    console.log(`\n📅 [${market}] 重跑 ${dates.length} 個交易日: ${dates[0] ?? 'n/a'} ~ ${dates[dates.length - 1] ?? 'n/a'}`);

    // 為每個市場建立 scanner 一次以拿 stock list（後續每天算歷史 top 500 共用）
    const scanner = market === 'TW' ? new TaiwanScanner() : new ChinaScanner();
    const allStocks = await scanner.getStockList();

    for (const date of dates) {
      if (!isTradingDay(date, market)) {
        console.log(`   ⏭️  ${date} 非交易日，跳過`);
        continue;
      }

      console.log(`\n🔍 [${market} ${date}] 重跑掃描...`);
      try {
        // 算出「當日」的前 500 成交額（避免用今天的 top 500 去掃歷史）
        const historicalRank = await computeTurnoverRankAsOfDate(market, allStocks, date, 500);
        if (historicalRank.size === 0) {
          console.warn(`   ⚠️  ${date} 歷史 top500 為空（L1 可能沒到這天），跳過`);
          continue;
        }

        const result = await runScanPipeline({
          market,
          date,
          sessionType: 'post_close',
          directions: ['long', 'short'],
          mtfModes: ['daily', 'mtf'],
          force: true,
          deadlineMs: 600_000,
          strategy: activeStrategy,
          turnoverRankOverride: historicalRank,
        });
        const summary = Object.entries(result.counts).map(([k, v]) => `${k}=${v}`).join(' ');
        console.log(`   ✅ top500=${historicalRank.size} ${summary}`);
      } catch (err) {
        console.error(`   ❌ 失敗:`, err instanceof Error ? err.message : err);
      }
    }
  }

  console.log(`\n🎉 重跑完成，策略=${activeStrategy.id}`);
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
