/**
 * 重建成交額排名索引 data/turnover-rank/{market}.json
 *
 * 深度 = TURNOVER_INDEX_TOP_N[market]（TW 500 / CN 800，單一事實 lib/scanner/universeTopN.ts）。
 * 用途：升深度後手動重建（ScanPipeline 的 needsRebuild 也會在下一次掃描自癒）、
 * 索引壞檔急救。退化守衛（上櫃/滬深整片消失拒寫）照走 buildTurnoverRank。
 *
 * 用法：npx tsx scripts/rebuild-turnover-rank.ts [--market TW|CN|BOTH]
 */
import { config } from 'dotenv';
import { existsSync } from 'fs';
if (existsSync('.env.local')) config({ path: '.env.local' });
config();

async function rebuild(market: 'TW' | 'CN') {
  const { buildTurnoverRank } = await import('@/lib/scanner/TurnoverRank');
  const scanner = market === 'CN'
    ? new (await import('@/lib/scanner/ChinaScanner')).ChinaScanner()
    : new (await import('@/lib/scanner/TaiwanScanner')).TaiwanScanner();
  const stocks = await scanner.getStockList();
  console.log(`[${market}] getStockList: ${stocks.length} 檔`);
  const idx = await buildTurnoverRank(market, stocks);
  console.log(`[${market}] 重建完成: date=${idx.date} topN=${idx.topN} symbols=${idx.symbols.length}`);
}

async function main() {
  const arg = process.argv.find((a, i) => process.argv[i - 1] === '--market') ?? 'BOTH';
  const markets: ('TW' | 'CN')[] = arg === 'BOTH' ? ['TW', 'CN'] : [arg as 'TW' | 'CN'];
  for (const m of markets) await rebuild(m);
}

main().catch((e) => { console.error(e); process.exit(1); });
