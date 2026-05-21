/**
 * 觀察 ma20Slope 分佈 — 驗證 Tier 1 #1 Step A 加的欄位是否合理
 * 用法：npx tsx scripts/observe-ma20-slope.ts
 *
 * 預期：
 * - 多頭股 ma20Slope > 0（MA20 上彎）
 * - 空頭股 ma20Slope < 0（MA20 下彎）
 * - 盤整股 ma20Slope 接近 0
 */
import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { computeIndicators } from '../lib/indicators';
import { ma20Slope } from '../lib/rules/ruleUtils';
import { detectTrend } from '../lib/analysis/trendAnalysis';
import { Candle } from '../types';

const TW_DIR = './data/candles/TW';
const SAMPLE_SIZE = 300; // 取前 N 檔（按檔名字典序）

interface SlopeRecord {
  symbol: string;
  trend: '多頭' | '空頭' | '盤整';
  slope: number;
  ma20: number;
  close: number;
}

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

function pct(n: number): string {
  return (n * 100).toFixed(2) + '%';
}

function describe(arr: number[]): string {
  if (arr.length === 0) return '(empty)';
  const sorted = [...arr].sort((a, b) => a - b);
  const min = sorted[0];
  const max = sorted[sorted.length - 1];
  const median = sorted[Math.floor(sorted.length / 2)];
  const mean = arr.reduce((s, x) => s + x, 0) / arr.length;
  const p10 = sorted[Math.floor(sorted.length * 0.1)];
  const p90 = sorted[Math.floor(sorted.length * 0.9)];
  return `n=${arr.length}  median=${pct(median)}  mean=${pct(mean)}  p10=${pct(p10)}  p90=${pct(p90)}  min=${pct(min)}  max=${pct(max)}`;
}

function main() {
  const files = readdirSync(TW_DIR).filter(f => f.endsWith('.json')).slice(0, SAMPLE_SIZE);
  console.log(`Loading ${files.length} stocks from ${TW_DIR}...`);

  const records: SlopeRecord[] = [];
  let skipped = 0;
  for (const file of files) {
    const candles = loadCandles(file);
    if (!candles) { skipped++; continue; }
    const enriched = computeIndicators(candles);
    const lastIdx = enriched.length - 1;
    const slope = ma20Slope(enriched, lastIdx);
    const last = enriched[lastIdx];
    if (slope == null || last.ma20 == null) { skipped++; continue; }
    const trend = detectTrend(enriched, lastIdx);
    const symbol = file.replace(/\.TW\.json$/, '');
    records.push({ symbol, trend, slope, ma20: last.ma20, close: last.close });
  }

  console.log(`\nProcessed: ${records.length}, skipped: ${skipped}\n`);

  // 分組統計
  const bull = records.filter(r => r.trend === '多頭').map(r => r.slope);
  const bear = records.filter(r => r.trend === '空頭').map(r => r.slope);
  const flat = records.filter(r => r.trend === '盤整').map(r => r.slope);

  console.log('=== ma20Slope 分佈 (5-day % change) ===');
  console.log('多頭股 :', describe(bull));
  console.log('空頭股 :', describe(bear));
  console.log('盤整股 :', describe(flat));

  // Top 10 多頭斜率
  console.log('\n=== Top 10 最強多頭 (ma20Slope 最高) ===');
  const topBull = records
    .filter(r => r.trend === '多頭')
    .sort((a, b) => b.slope - a.slope)
    .slice(0, 10);
  topBull.forEach((r, i) => {
    console.log(`  ${i + 1}. ${r.symbol}  slope=${pct(r.slope)}  close=${r.close}  ma20=${r.ma20.toFixed(2)}`);
  });

  // Bottom 10 空頭斜率
  console.log('\n=== Bottom 10 最弱空頭 (ma20Slope 最低) ===');
  const botBear = records
    .filter(r => r.trend === '空頭')
    .sort((a, b) => a.slope - b.slope)
    .slice(0, 10);
  botBear.forEach((r, i) => {
    console.log(`  ${i + 1}. ${r.symbol}  slope=${pct(r.slope)}  close=${r.close}  ma20=${r.ma20.toFixed(2)}`);
  });

  // 直方圖
  console.log('\n=== ma20Slope 直方圖 ===');
  const buckets = [-Infinity, -0.05, -0.02, -0.01, 0, 0.01, 0.02, 0.05, Infinity];
  const labels = ['< -5%', '-5% ~ -2%', '-2% ~ -1%', '-1% ~ 0%', '0% ~ 1%', '1% ~ 2%', '2% ~ 5%', '> 5%'];
  const counts = new Array(labels.length).fill(0);
  for (const r of records) {
    for (let i = 0; i < buckets.length - 1; i++) {
      if (r.slope > buckets[i] && r.slope <= buckets[i + 1]) {
        counts[i]++;
        break;
      }
    }
  }
  const maxCount = Math.max(...counts);
  for (let i = 0; i < labels.length; i++) {
    const bar = '█'.repeat(Math.round((counts[i] / maxCount) * 40));
    console.log(`  ${labels[i].padEnd(12)} | ${String(counts[i]).padStart(4)} ${bar}`);
  }
}

main();
