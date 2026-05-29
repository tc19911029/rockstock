/**
 * Verify fundamental agent prefetch for 603986 (兆易創新) end-to-end.
 *
 * 跑 buildFundamentalQuestion（CN 版）→ 寫 /tmp/rockstock-agents/{today}/603986/fundamental-question.json
 * → 對照用戶提供的東方財富欄位：
 *     股價 514.18 / 收益（一）2.084 / 市盈率動 61.68 / 市盈率 TTM 125.40 / 市盈率靜 218.74
 */

import { buildFundamentalQuestion } from '../lib/agents/agents/fundamentalAgent';
import { writeFundamentalQuestion } from '../lib/agents/orchestrator';

async function main() {
  const today = new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Taipei' });
  const symbol = '603986.SS';
  const runId = `verify-${today}-${symbol}`;

  console.log(`[verify-fundamental-603986] date=${today} symbol=${symbol}`);

  const q = await buildFundamentalQuestion({
    runId,
    date: today,
    symbol,
    market: 'CN',
    name: '兆易創新',
    industry: '半導體',
  });

  const filePath = await writeFundamentalQuestion(q);
  console.log(`✓ question written to ${filePath}`);

  const v = q.groundTruth.valuationInputs;
  if (!v) {
    console.error('✗ valuationInputs not built');
    process.exit(1);
  }
  console.log('');
  console.log('── 對照用戶範例 ──');
  console.log(`市場            ${v.market}`);
  console.log(`股價            ${v.currentPrice} （用戶 514.18）`);
  console.log(`最新季 EPS       ${v.quarterlyHistory[0]?.eps ?? 'N/A'} （用戶 2.084）`);
  console.log(`TTM PE          ${v.ttmPe?.toFixed(2)} （用戶 125.40）`);
  console.log(`動態 PE          ${v.dynamicPe?.toFixed(2)} （用戶 61.68）`);
  console.log(`靜態 PE          ${v.staticPe?.toFixed(2)} （用戶 218.74）`);
  console.log(`去年全年 EPS     ${v.lastYearTotalEps?.toFixed(2)} （用戶 2.35）`);
  console.log(`每股淨值         ${v.bookValuePerShare?.toFixed(2) ?? 'N/A'}`);
  console.log(`總股本          ${v.sharesOutstanding ?? 'N/A'}`);
  console.log(`產業模板         ${v.industryTemplate} (${v.industryTemplateLabel})`);
  console.log(`合理 PE 區間     ${v.reasonablePeRange.pessimistic} / ${v.reasonablePeRange.base} / ${v.reasonablePeRange.optimistic}`);
  console.log(`月營收（陸股應為空陣列）${v.monthlyRevenueHistory.length}`);

  if (q.groundTruth.fetchErrors.length > 0) {
    console.log('');
    console.log('── fetch errors ──');
    q.groundTruth.fetchErrors.forEach((e) => console.log(`  · ${e}`));
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
