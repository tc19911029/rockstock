/**
 * Verify fundamental agent prefetch for 3661 (世芯-KY) end-to-end.
 *
 * 跑 buildFundamentalQuestion → 寫 /tmp/rockstock-agents/{today}/3661/fundamental-question.json
 * → 印出關鍵欄位 + 對照用戶範例（TTM PE ≈ 66 / shares ≈ 81M / Q1 EPS 17.55）
 */

import path from 'node:path';
import { promises as fs } from 'node:fs';
import { buildFundamentalQuestion } from '../lib/agents/agents/fundamentalAgent';
import { writeFundamentalQuestion } from '../lib/agents/orchestrator';

async function main() {
  const today = new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Taipei' });
  const symbol = '3661';
  const runId = `verify-${today}-${symbol}`;

  console.log(`[verify-fundamental-3661] date=${today} symbol=${symbol}`);

  const q = await buildFundamentalQuestion({
    runId,
    date: today,
    symbol,
    market: 'TW',
    name: '世芯-KY',
    industry: '其他電子業',
  });

  const filePath = await writeFundamentalQuestion(q);
  console.log(`✓ question written to ${filePath}`);

  // ── 對照用戶範例 ──
  const v = q.groundTruth.valuationInputs;
  if (!v) {
    console.error('✗ valuationInputs not built');
    process.exit(1);
  }
  console.log('');
  console.log('── 核心欄位對照 ──');
  console.log(`股價            ${v.currentPrice}`);
  console.log(`TTM EPS         ${v.ttmEps}`);
  console.log(`TTM PE          ${v.ttmPe?.toFixed(2)}`);
  console.log(`流通股數         ${v.sharesOutstanding}`);
  console.log(`每股淨值         ${v.bookValuePerShare}`);
  console.log(`產業模板         ${v.industryTemplate} (${v.industryTemplateLabel})`);
  console.log(`合理 PE 區間     ${v.reasonablePeRange.pessimistic} / ${v.reasonablePeRange.base} / ${v.reasonablePeRange.optimistic}`);
  console.log(`季財報 N         ${v.quarterlyHistory.length}`);
  console.log(`月營收 N         ${v.monthlyRevenueHistory.length}`);
  console.log(`稀釋事件 N       ${v.dilutionEvents.length}`);

  if (v.quarterlyHistory.length > 0) {
    const q1 = v.quarterlyHistory[0];
    console.log('');
    console.log('── 最新季財報 ──');
    console.log(`季度            ${q1.quarter}`);
    console.log(`營收            ${q1.revenue}`);
    console.log(`稅後淨利         ${q1.netIncome}`);
    console.log(`EPS             ${q1.eps}`);
    console.log(`淨利率           ${q1.netMargin}`);
  }

  if (v.monthlyRevenueHistory.length > 0) {
    const m1 = v.monthlyRevenueHistory[0];
    console.log('');
    console.log('── 最新月營收 ──');
    console.log(`月份            ${m1.month}`);
    console.log(`營收            ${m1.revenue}`);
    console.log(`YoY             ${m1.yoy}`);
  }

  if (v.dilutionEvents.length > 0) {
    console.log('');
    console.log('── 稀釋事件 ──');
    for (const d of v.dilutionEvents) {
      console.log(`${d.type} — ${d.newShares} 股 (${d.expectedDate})`);
    }
  }

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
