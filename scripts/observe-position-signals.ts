/**
 * 觀察 弱中透強 / 強中透弱 / 接近壓力區 / 接近支撐區 全市場覆蓋率
 * 用法：npx tsx scripts/observe-position-signals.ts
 */
import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { computeIndicators } from '../lib/indicators';
import {
  isStrongInWeaknessAtBottom,
  isWeakInStrengthAtTop,
  isStrongInWeakness,
  isWeakInStrength,
} from '../lib/rules/ruleUtils';
import { detectTrend, detectTrendPosition } from '../lib/analysis/trendAnalysis';
import { Candle } from '../types';

const TW_DIR = './data/candles/TW';

function loadCandles(file: string): Candle[] | null {
  try {
    const raw = JSON.parse(readFileSync(join(TW_DIR, file), 'utf-8'));
    const candles = raw.candles ?? raw;
    if (!Array.isArray(candles) || candles.length < 30) return null;
    return candles as Candle[];
  } catch {
    return null;
  }
}

function main() {
  const files = readdirSync(TW_DIR).filter(f => f.endsWith('.json'));
  console.log(`Scanning ${files.length} TW stocks...\n`);

  const stats = {
    total: 0,
    strongInWeaknessRaw: 0,
    weakInStrengthRaw: 0,
    strongInWeaknessAtBottom: 0,
    weakInStrengthAtTop: 0,
    positions: {} as Record<string, number>,
  };

  const strongAtBottom: string[] = [];
  const weakAtTop: string[] = [];

  for (const file of files) {
    const candles = loadCandles(file);
    if (!candles) continue;
    const enriched = computeIndicators(candles);
    const lastIdx = enriched.length - 1;
    if (lastIdx < 1) continue;

    stats.total++;
    const c = enriched[lastIdx];
    const prev = enriched[lastIdx - 1];

    if (isStrongInWeakness(c, prev)) stats.strongInWeaknessRaw++;
    if (isWeakInStrength(c, prev)) stats.weakInStrengthRaw++;
    if (isStrongInWeaknessAtBottom(enriched, lastIdx)) {
      stats.strongInWeaknessAtBottom++;
      strongAtBottom.push(file.replace(/\.TW\.json$/, ''));
    }
    if (isWeakInStrengthAtTop(enriched, lastIdx)) {
      stats.weakInStrengthAtTop++;
      weakAtTop.push(file.replace(/\.TW\.json$/, ''));
    }

    const pos = detectTrendPosition(enriched, lastIdx);
    stats.positions[pos] = (stats.positions[pos] ?? 0) + 1;
  }

  const pct = (n: number) => `${((n / stats.total) * 100).toFixed(2)}%`;

  console.log('=== 形態出現率（最後一根 K 棒）===');
  console.log(`Total scanned: ${stats.total}`);
  console.log(`弱中透強純形態 (紅K但跌): ${stats.strongInWeaknessRaw} (${pct(stats.strongInWeaknessRaw)})`);
  console.log(`強中透弱純形態 (黑K但漲): ${stats.weakInStrengthRaw} (${pct(stats.weakInStrengthRaw)})`);
  console.log(`低檔弱中透強 (位置條件版): ${stats.strongInWeaknessAtBottom} (${pct(stats.strongInWeaknessAtBottom)})`);
  console.log(`高檔強中透弱 (位置條件版): ${stats.weakInStrengthAtTop} (${pct(stats.weakInStrengthAtTop)})`);

  console.log('\n=== TrendPosition 分佈 ===');
  const sortedPositions = Object.entries(stats.positions).sort((a, b) => b[1] - a[1]);
  for (const [pos, n] of sortedPositions) {
    console.log(`  ${pos.padEnd(16)}: ${String(n).padStart(4)} (${pct(n)})`);
  }

  if (strongAtBottom.length > 0) {
    console.log(`\n=== 低檔弱中透強範例 (前 ${Math.min(15, strongAtBottom.length)} 檔) ===`);
    strongAtBottom.slice(0, 15).forEach(s => console.log(`  ${s}`));
  }
  if (weakAtTop.length > 0) {
    console.log(`\n=== 高檔強中透弱範例 (前 ${Math.min(15, weakAtTop.length)} 檔) ===`);
    weakAtTop.slice(0, 15).forEach(s => console.log(`  ${s}`));
  }
}

main();
