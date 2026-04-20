import { config } from 'dotenv';
import { existsSync } from 'fs';
if (existsSync('.env.local')) config({ path: '.env.local' });
config();

import { ChinaScanner } from '../lib/scanner/ChinaScanner';
import { ZHU_PURE_BOOK } from '../lib/strategy/StrategyConfig';

async function main() {
  const date = process.argv[2] || '2026-04-17';
  const scanner = new ChinaScanner();
  const all = await scanner.getStockList();
  // 只掃 603052 一支，看結果
  const one = all.filter(s => s.symbol === '603052.SS');
  console.log('stock in list: ' + (one.length > 0 ? 'YES' : 'NO'));
  if (one.length === 0) return;

  console.log('\n跑 scanLongCandidates for 603052 only...');
  const res = await scanner.scanSOP(one, date, ZHU_PURE_BOOK.thresholds);
  console.log('candidates count = ' + res.results.length);
  console.log('marketTrend = ' + res.marketTrend);
  console.log('diagnostics:', JSON.stringify(res.diagnostics, null, 2));
  if (res.results.length > 0) {
    const c = res.results[0];
    console.log('603052: six=' + c.sixConditionsScore + '/6, mtf=' + c.mtfScore);
  } else {
    console.log('603052 未通過 scanner');
  }
}
main().catch(console.error);
