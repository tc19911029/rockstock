/**
 * 檢驗 2303 聯電 2026-04-15 / 2026-04-16 是否能過策略 A（六條件+戒律）
 * 重點觀察戒律6（回檔底底低）修正後行為
 */

import { promises as fs } from 'fs';
import { computeIndicators } from '../lib/indicators';
import { evaluateSixConditions, findPivots, detectTrend } from '../lib/analysis/trendAnalysis';
import { checkLongProhibitions } from '../lib/rules/entryProhibitions';

async function main(): Promise<void> {
  const raw = await fs.readFile('data/candles/TW/2303.TW.json', 'utf-8');
  const data = JSON.parse(raw) as {
    candles: Array<{ date: string; open: number; high: number; low: number; close: number; volume: number }>;
  };
  const bars = computeIndicators([...data.candles]);

  for (const target of ['2026-04-15', '2026-04-16']) {
    const idx = bars.findIndex(b => b.date === target);
    if (idx < 0) {
      console.log(`\n=== ${target}: 找不到 ===`);
      continue;
    }
    const b = bars[idx];
    console.log(`\n=== 2303 ${target} (index ${idx}) ===`);
    console.log(`  O=${b.open} H=${b.high} L=${b.low} C=${b.close} Vol=${b.volume}`);
    console.log(`  MA5=${b.ma5?.toFixed(2)} MA10=${b.ma10?.toFixed(2)} MA20=${b.ma20?.toFixed(2)} MA60=${b.ma60?.toFixed(2)}`);

    const trend = detectTrend(bars, idx);
    console.log(`  趨勢: ${trend}`);

    const lows = findPivots(bars, idx, 10, 0.02, false)
      .filter(p => p.type === 'low')
      .slice(0, 3);
    console.log(`  近期已確認波低（新→舊）:`);
    for (const p of lows) {
      console.log(`    idx=${p.index} date=${bars[p.index].date} low=${p.price}`);
    }

    const sc = evaluateSixConditions(bars, idx);
    console.log(`  六條件: total=${sc.totalScore}/6 core=${sc.coreScore}/5 isCoreReady=${sc.isCoreReady}`);
    const checks = ['trend', 'ma', 'position', 'volume', 'kbar', 'indicator'] as const;
    for (const key of checks) {
      const cond = (sc as unknown as Record<string, { pass: boolean; detail?: string }>)[key];
      console.log(`    ${key}: ${cond.pass ? '✅' : '❌'} ${cond.detail ?? ''}`);
    }

    const prohib = checkLongProhibitions(bars, idx);
    console.log(`  戒律違反: ${prohib.prohibited ? '❌ ' + prohib.reasons.length + ' 條' : '✅ 通過'}`);
    for (const r of prohib.reasons) console.log(`    - ${r}`);

    const pickedByA = sc.isCoreReady && !prohib.prohibited;
    console.log(`  🧪 策略 A（六條件 PASS + 戒律 PASS）: ${pickedByA ? '🟢 入選' : '🔴 未入選'}`);
  }
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
