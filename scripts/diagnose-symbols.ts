/**
 * 診斷多個股票為何未入選
 * 用法：npx tsx scripts/diagnose-symbols.ts 3105.TWO 2303.TW --date 2026-04-16
 */
import { config } from 'dotenv';
import { existsSync } from 'fs';
if (existsSync('.env.local')) config({ path: '.env.local' });
config();

import { TaiwanScanner } from '../lib/scanner/TaiwanScanner';
import { ZHU_PURE_BOOK } from '../lib/strategy/StrategyConfig';
import { evaluateSixConditions } from '../lib/analysis/trendAnalysis';
import { checkLongProhibitions } from '../lib/rules/entryProhibitions';
import { evaluateElimination } from '../lib/scanner/eliminationFilter';
import { readCandleFile } from '../lib/datasource/CandleStorageAdapter';
import { computeTurnoverRankAsOfDate } from '../lib/scanner/TurnoverRank';
import { computeIndicators } from '../lib/indicators';
import { buildInstitutionalMapTW } from '../lib/storage/institutionalStorage';

async function main() {
  const args = process.argv.slice(2);
  let date = '2026-04-16';
  const symbols: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--date' && args[i + 1]) { date = args[i + 1]; i++; }
    else symbols.push(args[i]);
  }
  if (symbols.length === 0) symbols.push('3105.TWO', '2303.TW');

  const th = ZHU_PURE_BOOK.thresholds;
  const scanner = new TaiwanScanner();
  const all = await scanner.getStockList();
  const rank = await computeTurnoverRankAsOfDate('TW', all, date, 500);
  const instMap = await buildInstitutionalMapTW(date, 5);

  for (const symbol of symbols) {
    console.log(`\n======= ${symbol} @ ${date} =======`);
    const file = await readCandleFile(symbol, 'TW');
    if (!file) { console.log('❌ 找不到 L1'); continue; }
    const idx = file.candles.findIndex(c => c.date.slice(0, 10) === date);
    if (idx < 0) { console.log('❌ 找不到日期'); continue; }
    const candles = file.candles.slice(0, idx + 1);
    const withInd = computeIndicators(candles);
    const last = withInd[withInd.length - 1];
    console.log(`K: open=${last.open} high=${last.high} low=${last.low} close=${last.close} vol=${last.volume}`);
    const topRank = rank.get(symbol);
    console.log(`Top 500: ${topRank ? '#' + topRank : '❌ 不在 top 500'}`);

    const six = evaluateSixConditions(withInd, withInd.length - 1, th);
    console.log(`六條件: ${six.totalScore}/6 (核心 ${six.coreScore}/5)`);
    const conds = {
      '①趨勢': six.trend, '②均線': six.ma, '③位置': six.position,
      '④量能': six.volume, '⑤K棒': six.kbar, '⑥指標': six.indicator,
    } as const;
    for (const [k, r] of Object.entries(conds)) {
      console.log(`  ${k}: ${r.pass ? '✅' : '❌'} ${r.detail}`);
    }

    const instSym = symbol.replace(/\.(TW|TWO)$/i, '');
    const hist = instMap.get(instSym);
    console.log('法人近5日:', hist ? hist.map(h => `${h.date}=${h.netShares.toLocaleString()}`).join(' | ') : 'N/A');
    const ctx = hist ? { institutionalHistory: hist } : undefined;
    const pro = checkLongProhibitions(withInd, withInd.length - 1, ctx);
    console.log('戒律:', pro.prohibited ? `❌ ${pro.reasons.join('; ')}` : '✅');

    const elim = evaluateElimination(withInd, withInd.length - 1);
    console.log('淘汰:', elim.eliminated ? `❌ ${elim.reasons.join('; ')}` : '✅');
  }
}

main().catch(err => { console.error(err); process.exit(1); });
