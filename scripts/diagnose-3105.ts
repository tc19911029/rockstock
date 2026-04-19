/**
 * 診斷 3105 穩懋 4/16 為何沒被 zhu-pure-book 選中
 */
import { config } from 'dotenv';
import { existsSync } from 'fs';
if (existsSync('.env.local')) config({ path: '.env.local' });
config();

import { TaiwanScanner } from '../lib/scanner/TaiwanScanner';
import { ZHU_PURE_BOOK } from '../lib/strategy/StrategyConfig';
import { evaluateSixConditions, detectTrend } from '../lib/analysis/trendAnalysis';
import { checkLongProhibitions } from '../lib/rules/entryProhibitions';
import { evaluateElimination } from '../lib/scanner/eliminationFilter';
import { evaluateMultiTimeframe } from '../lib/analysis/multiTimeframeFilter';
import { computeTurnoverRankAsOfDate } from '../lib/scanner/TurnoverRank';
import { readCandleFile } from '../lib/datasource/CandleStorageAdapter';

async function main() {
  const market = 'TW' as const;
  const symbol = '3105.TWO';
  const asOfDate = '2026-04-16';
  const th = ZHU_PURE_BOOK.thresholds;

  const file = await readCandleFile(symbol, market);
  if (!file) { console.log('找不到 L1'); return; }

  const idx = file.candles.findIndex(c => c.date.slice(0,10) === asOfDate);
  if (idx < 0) { console.log('找不到 4/16'); return; }
  const candles = file.candles.slice(0, idx + 1);
  const last = candles[candles.length - 1];

  console.log('=== 3105 穩懋 4/16 診斷 ===');
  console.log('4/16 K棒:', JSON.stringify(last));
  console.log('近 3 日收盤:', candles.slice(-3).map(c => `${c.date.slice(0,10)}=${c.close}`).join(' '));
  console.log();

  // Top 500 check
  const scanner = new TaiwanScanner();
  const all = await scanner.getStockList();
  const rank = await computeTurnoverRankAsOfDate(market, all, asOfDate, 500);
  const r = rank.get(symbol);
  console.log('Top 500 排名:', r ? `#${r}` : '❌ 不在 top 500');
  console.log();

  // 六條件
  // 先補上指標（MA5/10/20/60/macd/kd）— evaluateSixConditions 需要已含指標
  const { computeIndicators } = await import('../lib/indicators');
  const withInd = computeIndicators(candles);
  const six = evaluateSixConditions(withInd, withInd.length - 1, th);
  console.log('六條件總分:', six.totalScore, '/ 6 (核心:', six.coreScore, '/ 5)');
  const list = [
    ['①趨勢', six.trend],
    ['④均線', six.ma],
    ['②位置', six.position],
    ['⑤量能', six.volume],
    ['③K棒',  six.kbar],
    ['⑥指標', six.indicator],
  ] as const;
  for (const [label, r] of list) console.log(' ', label, r.pass ? '✅' : '❌', '|', r.detail);
  console.log();

  // Trend state (已在 six.trend.state)
  console.log('Trend state:', six.trend.state);
  console.log();

  // Prohibition
  const pro = checkLongProhibitions(withInd, withInd.length - 1);
  console.log('戒律:', pro.prohibited ? `❌ 擋住 (${pro.reasons.join(', ')})` : '✅ 通過');
  console.log();

  // Elimination
  const elim = evaluateElimination(withInd, withInd.length - 1);
  console.log('淘汰法:', elim.eliminated ? `❌ 淘汰 (${elim.reasons.join(', ')})` : '✅ 通過');
  console.log();

  // MTF
  const mtf = evaluateMultiTimeframe(candles, th);
  console.log('MTF 分數:', mtf.score, '/ 4', mtf.pass ? '✅' : '❌');
  console.log('  週線趨勢:', mtf.detail.weeklyTrendPass ? '✅' : '❌', '|', mtf.detail.weeklyTrendReason);
  console.log('  週均線:', mtf.detail.weeklyMAPass ? '✅' : '❌', '|', mtf.detail.weeklyMAReason);
  console.log('  週壓力:', mtf.detail.weeklyResistancePass ? '✅' : '❌', '|', mtf.detail.weeklyResistanceReason);
  console.log('  月趨勢:', mtf.detail.monthlyTrendPass ? '✅' : '❌', '|', mtf.detail.monthlyTrendReason);
  console.log();

  // 結論
  const bullMinScore = th.bullMinScore;
  console.log('=== 結論 ===');
  console.log(`門檻 (多頭): ${bullMinScore}/6`);
  console.log(`六條件: ${six.score >= bullMinScore ? '✅過' : '❌不過'}`);
  console.log(`戒律: ${pro.passed ? '✅過' : '❌擋住'}`);
  console.log(`淘汰法: ${elim.eliminated ? '❌淘汰' : '✅過'}`);
  console.log(`MTF: ${mtf.pass ? '✅過' : '❌不過'} (分=${mtf.score}/${th.mtfMinScore})`);
}

main().catch(err => { console.error(err); process.exit(1); });
