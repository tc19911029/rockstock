/**
 * Compare chart candidate quality tiers by subsequent 3% confirmation rate.
 * Repeated days with the same type/neckline/pivots count as one event.
 *
 * Usage: MAX_SYMBOLS=500 LOOKBACK_BARS=260 npx tsx scripts/backtest-pattern-candidate-quality.ts
 */
import path from 'path';
import { promises as fs } from 'fs';

import {
  detectLetterNStructure,
  detectTopPatternsStructure,
  PATTERN_DISPLAY_MIN_QUALITY_SCORE,
  type LetterNResult,
  type TopPatternResult,
} from '@/lib/analysis/v12LetterN';
import { computeIndicators } from '@/lib/indicators';
import type { Candle, CandleWithIndicators } from '@/types';

interface Stats {
  events: number;
  confirmed: number;
  trainEvents: number;
  trainConfirmed: number;
  testEvents: number;
  testConfirmed: number;
}

const HORIZON = 20;
const MAX_SYMBOLS = Number(process.env.MAX_SYMBOLS ?? 500);
const LOOKBACK_BARS = Number(process.env.LOOKBACK_BARS ?? 260);

function signature(result: LetterNResult | TopPatternResult): string | null {
  if (!result.patternType || result.necklinePrice == null || !result.pivots?.length) return null;
  return `${result.patternType}:${result.necklinePrice.toPrecision(8)}:${result.pivots.map(pivot => pivot.index).join(',')}`;
}

function addPendingEvent(
  stats: Stats,
  result: LetterNResult | TopPatternResult,
  candles: CandleWithIndicators[],
  idx: number,
  kind: 'bottom' | 'top',
  isTest: boolean,
): void {
  if (result.necklinePrice == null) return;
  const threshold = result.necklinePrice * (kind === 'bottom' ? 1.03 : 0.97);
  const current = candles[idx].close;
  if (kind === 'bottom' ? current >= threshold : current <= threshold) return;
  stats.events++;
  if (isTest) stats.testEvents++;
  else stats.trainEvents++;
  const future = candles.slice(idx + 1, idx + HORIZON + 1);
  if (future.some(candle => kind === 'bottom' ? candle.close >= threshold : candle.close <= threshold)) {
    stats.confirmed++;
    if (isTest) stats.testConfirmed++;
    else stats.trainConfirmed++;
  }
}

async function main() {
  const dir = path.join(process.cwd(), 'data', 'candles', 'TW');
  const files = (await fs.readdir(dir)).filter(file => file.endsWith('.json')).sort().slice(0, MAX_SYMBOLS);
  const stats = {
    generalBottom: { events: 0, confirmed: 0, trainEvents: 0, trainConfirmed: 0, testEvents: 0, testConfirmed: 0 },
    strictBottom: { events: 0, confirmed: 0, trainEvents: 0, trainConfirmed: 0, testEvents: 0, testConfirmed: 0 },
    generalTop: { events: 0, confirmed: 0, trainEvents: 0, trainConfirmed: 0, testEvents: 0, testConfirmed: 0 },
    strictTop: { events: 0, confirmed: 0, trainEvents: 0, trainConfirmed: 0, testEvents: 0, testConfirmed: 0 },
  };

  for (const file of files) {
    try {
      const parsed = JSON.parse(await fs.readFile(path.join(dir, file), 'utf8'));
      const raw: Candle[] = Array.isArray(parsed) ? parsed : parsed.candles ?? [];
      const candles = computeIndicators(raw);
      const start = Math.max(60, candles.length - LOOKBACK_BARS - HORIZON);
      const end = candles.length - HORIZON - 1;
      const splitIndex = Math.floor((start + end) / 2);
      const lastSignature: Record<string, string | null> = {
        generalBottom: null,
        strictBottom: null,
        generalTop: null,
        strictTop: null,
      };
      for (let idx = start; idx <= end; idx++) {
        const layers = [
          ['generalBottom', detectLetterNStructure(candles, idx, 0), 'bottom'],
          ['strictBottom', detectLetterNStructure(candles, idx, PATTERN_DISPLAY_MIN_QUALITY_SCORE), 'bottom'],
          ['generalTop', detectTopPatternsStructure(candles, idx, 0), 'top'],
          ['strictTop', detectTopPatternsStructure(candles, idx, PATTERN_DISPLAY_MIN_QUALITY_SCORE), 'top'],
        ] as const;
        for (const [key, result, kind] of layers) {
          const currentSignature = signature(result);
          if (currentSignature && currentSignature !== lastSignature[key]) {
            addPendingEvent(stats[key], result, candles, idx, kind, idx > splitIndex);
          }
          lastSignature[key] = currentSignature;
        }
      }
    } catch {
      // Skip malformed local data; sample size is printed below.
    }
  }

  const row = (label: string, value: Stats) => {
    const rate = value.events > 0 ? value.confirmed / value.events * 100 : 0;
    const trainRate = value.trainEvents > 0 ? value.trainConfirmed / value.trainEvents * 100 : 0;
    const testRate = value.testEvents > 0 ? value.testConfirmed / value.testEvents * 100 : 0;
    console.log(`${label}: ${value.confirmed}/${value.events} = ${rate.toFixed(1)}%｜train ${trainRate.toFixed(1)}%｜test ${testRate.toFixed(1)}%`);
  };
  console.log(`TW symbols=${files.length} lookback=${LOOKBACK_BARS} horizon=${HORIZON}`);
  row('底部一般候選', stats.generalBottom);
  row(`底部品質>=${PATTERN_DISPLAY_MIN_QUALITY_SCORE}`, stats.strictBottom);
  row('頂部一般候選', stats.generalTop);
  row(`頂部品質>=${PATTERN_DISPLAY_MIN_QUALITY_SCORE}`, stats.strictTop);
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
