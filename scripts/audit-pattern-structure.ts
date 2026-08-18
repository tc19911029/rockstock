/**
 * Audit current chart-level pattern candidates (not trading triggers).
 *
 * Usage: npx tsx scripts/audit-pattern-structure.ts [TW|CN] [date]
 */
import path from 'path';
import { promises as fs } from 'fs';

import { computeIndicators } from '@/lib/indicators';
import {
  detectLetterNStructure,
  detectTopPatternsStructure,
  PATTERN_DISPLAY_MIN_QUALITY_SCORE,
} from '@/lib/analysis/v12LetterN';
import type { Candle } from '@/types';

async function main() {
  const market = (process.argv[2] ?? 'TW') as 'TW' | 'CN';
  const date = process.argv[3] ?? new Date().toISOString().slice(0, 10);
  const dir = path.join(process.cwd(), 'data', 'candles', market);
  const files = (await fs.readdir(dir)).filter(file => file.endsWith('.json'));
  const bottomCounts: Record<string, number> = {};
  const topCounts: Record<string, number> = {};
  const examples: Record<string, string[]> = {};
  let processed = 0;
  let bottom = 0;
  let top = 0;
  let overlap = 0;
  let union = 0;
  const scoreBuckets = [80, 85, 90, 92, 94, 96, 98].map(min => ({ min, bottom: 0, top: 0, overlap: 0, union: 0 }));

  for (const file of files) {
    try {
      const parsed = JSON.parse(await fs.readFile(path.join(dir, file), 'utf8'));
      const raw: Candle[] = Array.isArray(parsed) ? parsed : parsed.candles ?? [];
      const dateIndex = raw.findIndex(candle => candle.date.replace(/\*$/, '') === date);
      if (dateIndex < 30) continue;
      const candles = computeIndicators(raw.slice(0, dateIndex + 1));
      const idx = candles.length - 1;
      const symbol = file.replace(/\.json$/, '');
      const b = detectLetterNStructure(candles, idx, PATTERN_DISPLAY_MIN_QUALITY_SCORE);
      const t = detectTopPatternsStructure(candles, idx, PATTERN_DISPLAY_MIN_QUALITY_SCORE);
      const hasBottom = Boolean(b.patternType);
      const hasTop = Boolean(t.patternType);
      processed++;
      if (hasBottom) {
        bottom++;
        bottomCounts[b.patternType!] = (bottomCounts[b.patternType!] ?? 0) + 1;
        (examples[b.patternType!] ??= []).push(symbol);
      }
      if (hasTop) {
        top++;
        topCounts[t.patternType!] = (topCounts[t.patternType!] ?? 0) + 1;
        (examples[t.patternType!] ??= []).push(symbol);
      }
      if (hasBottom && hasTop) overlap++;
      if (hasBottom || hasTop) union++;
      for (const bucket of scoreBuckets) {
        const scoredBottom = (b.qualityScore ?? 0) >= bucket.min;
        const scoredTop = (t.qualityScore ?? 0) >= bucket.min;
        if (scoredBottom) bucket.bottom++;
        if (scoredTop) bucket.top++;
        if (scoredBottom && scoredTop) bucket.overlap++;
        if (scoredBottom || scoredTop) bucket.union++;
      }
      if (['3006.TW', '6770.TW', '3081.TW', '3081.TWO', '3661.TW'].includes(symbol)) {
        console.log(JSON.stringify({
          symbol,
          close: candles[idx].close,
          bottom: hasBottom ? b : null,
          top: hasTop ? t : null,
        }));
      }
    } catch {
      // Corrupt or incompatible local fixtures are outside this detector audit.
    }
  }

  const pct = (count: number) => processed === 0 ? '0.0%' : `${(count / processed * 100).toFixed(1)}%`;
  console.log(`\n${market} ${date} processed=${processed}`);
  console.log(`bottom=${bottom} (${pct(bottom)}) top=${top} (${pct(top)}) overlap=${overlap} (${pct(overlap)}) union=${union} (${pct(union)})`);
  for (const bucket of scoreBuckets) {
    console.log(`score>=${bucket.min}: bottom=${pct(bucket.bottom)} top=${pct(bucket.top)} overlap=${pct(bucket.overlap)} union=${pct(bucket.union)}`);
  }
  console.log('bottom types', bottomCounts);
  console.log('top types', topCounts);
  for (const [type, symbols] of Object.entries(examples)) {
    console.log(`${type}: ${symbols.slice(0, 5).join(', ')}`);
  }
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
