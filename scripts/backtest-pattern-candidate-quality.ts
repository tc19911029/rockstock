/**
 * Compare chart candidate quality tiers by subsequent 3% confirmation rate.
 * Repeated days with the same type/neckline/pivots count as one event.
 *
 * Usage: MAX_SYMBOLS=500 LOOKBACK_BARS=260 npx tsx scripts/backtest-pattern-candidate-quality.ts [TW|CN]
 */
import path from 'path';
import { promises as fs } from 'fs';

import {
  detectLetterNStructure,
  detectTopPatternsStructure,
  BOTTOM_PATTERN_DISPLAY_MIN_QUALITY_SCORE,
  TOP_PATTERN_DISPLAY_MIN_QUALITY_SCORE,
  type LetterNResult,
  type TopPatternResult,
} from '@/lib/analysis/v12LetterN';
import { computeIndicators } from '@/lib/indicators';
import type { Candle, CandleWithIndicators } from '@/types';

interface Stats {
  events: number;
  confirmed: number;
  targetFirst: number;
  stopFirst: number;
  unresolved: number;
  ambiguous: number;
  trainEvents: number;
  trainConfirmed: number;
  trainTargetFirst: number;
  trainStopFirst: number;
  testEvents: number;
  testConfirmed: number;
  testTargetFirst: number;
  testStopFirst: number;
}

const CONFIRM_HORIZON = 20;
const OUTCOME_HORIZON = 60;
const MAX_SYMBOLS = Number(process.env.MAX_SYMBOLS ?? 500);
const LOOKBACK_BARS = Number(process.env.LOOKBACK_BARS ?? 260);
const QUALITY_THRESHOLDS = [0, 80, 85, 90, 92, 94, 96, 98];

function emptyStats(): Stats {
  return {
    events: 0, confirmed: 0, targetFirst: 0, stopFirst: 0, unresolved: 0, ambiguous: 0,
    trainEvents: 0, trainConfirmed: 0, trainTargetFirst: 0, trainStopFirst: 0,
    testEvents: 0, testConfirmed: 0, testTargetFirst: 0, testStopFirst: 0,
  };
}

function signature(result: LetterNResult | TopPatternResult): string | null {
  if (!result.patternType || result.necklinePrice == null || !result.pivots?.length) return null;
  // 斜頸線（楔形／鑽石）會隨 idx 每天投射出不同價位；若把當日頸線價放進 key，
  // 同一組腳位會每天被誤算成新事件。型態與腳位已足以唯一識別一段結構。
  return `${result.patternType}:${result.pivots.map(pivot => `${pivot.type}:${pivot.index}`).join(',')}`;
}

function addEvent(
  stats: Stats,
  result: LetterNResult | TopPatternResult,
  candles: CandleWithIndicators[],
  idx: number,
  kind: 'bottom' | 'top',
  isTest: boolean,
): void {
  if (result.necklinePrice == null) return;
  const confirmationPrice = result.necklinePrice * (kind === 'bottom' ? 1.03 : 0.97);
  if (result.patternTargetPrice == null || result.structureBrokenPrice == null) return;
  // 只從尚未確認的候選開始觀察；若事件首次被 detector 看見時已突破／已終結，
  // 就不能拿它回頭宣稱「候選品質預測成功」。
  const currentAlreadyConfirmed = kind === 'bottom'
    ? candles[idx].close >= confirmationPrice
    : candles[idx].close <= confirmationPrice;
  if (currentAlreadyConfirmed) return;
  stats.events++;
  if (isTest) stats.testEvents++;
  else stats.trainEvents++;
  let confirmationIndex = -1;
  for (let i = idx; i <= Math.min(candles.length - 1, idx + CONFIRM_HORIZON); i++) {
    if (kind === 'bottom' ? candles[i].close >= confirmationPrice : candles[i].close <= confirmationPrice) {
      confirmationIndex = i;
      break;
    }
  }
  if (confirmationIndex < 0) return;

  stats.confirmed++;
  if (isTest) stats.testConfirmed++;
  else stats.trainConfirmed++;

  const end = Math.min(candles.length - 1, confirmationIndex + OUTCOME_HORIZON);
  for (let i = confirmationIndex; i <= end; i++) {
    const targetHit = kind === 'bottom'
      ? candles[i].close >= result.patternTargetPrice
      : candles[i].close <= result.patternTargetPrice;
    const stopHit = kind === 'bottom'
      ? candles[i].close <= result.structureBrokenPrice
      : candles[i].close >= result.structureBrokenPrice;
    if (targetHit && stopHit) {
      stats.ambiguous++;
      return;
    }
    if (targetHit) {
      stats.targetFirst++;
      if (isTest) stats.testTargetFirst++;
      else stats.trainTargetFirst++;
      return;
    }
    if (stopHit) {
      stats.stopFirst++;
      if (isTest) stats.testStopFirst++;
      else stats.trainStopFirst++;
      return;
    }
  }
  stats.unresolved++;
}

async function main() {
  const market = (process.argv[2] ?? 'TW').toUpperCase();
  if (market !== 'TW' && market !== 'CN') {
    throw new Error(`Unsupported market: ${market}. Expected TW or CN.`);
  }
  const dir = path.join(process.cwd(), 'data', 'candles', market);
  const files = (await fs.readdir(dir)).filter(file => file.endsWith('.json')).sort().slice(0, MAX_SYMBOLS);
  const stats = Object.fromEntries(
    (['bottom', 'top'] as const).flatMap(kind =>
      QUALITY_THRESHOLDS.map(min => [`${kind}:${min}`, emptyStats()]),
    ),
  ) as Record<string, Stats>;
  const displayStats = {
    bottom: emptyStats(),
    top: emptyStats(),
  };
  const typeStats: Record<string, Stats> = {};

  for (const file of files) {
    try {
      const parsed = JSON.parse(await fs.readFile(path.join(dir, file), 'utf8'));
      const raw: Candle[] = Array.isArray(parsed) ? parsed : parsed.candles ?? [];
      const candles = computeIndicators(raw);
      const start = Math.max(60, candles.length - LOOKBACK_BARS - CONFIRM_HORIZON - OUTCOME_HORIZON);
      const end = candles.length - CONFIRM_HORIZON - OUTCOME_HORIZON - 1;
      const splitIndex = Math.floor((start + end) / 2);
      // 同一檔、同型態、同頸線與同腳位在整段樣本只算一次；舊版候選短暫消失後
      // 再出現會被重算，容易把反覆靠近頸線的型態灌成多筆事件。
      const seenSignatures = Object.fromEntries(Object.keys(stats).map(key => [key, new Set<string>()])) as Record<string, Set<string>>;
      // 幾何結構可能先在離頸線很遠時出現；畫面事件必須等 displayReady 首次成立才去重。
      // 不可共用上面的 seen，否則真正出現在使用者畫面上的那一天反而不會被回測。
      const seenDisplaySignatures = new Set<string>();
      for (let idx = start; idx <= end; idx++) {
        const layers = [
          ['bottom', detectLetterNStructure(candles, idx, 0)],
          ['top', detectTopPatternsStructure(candles, idx, 0)],
        ] as const;
        for (const [kind, result] of layers) {
          for (const min of QUALITY_THRESHOLDS) {
            const key = `${kind}:${min}`;
            const qualifies = Boolean(result.patternType) && (result.qualityScore ?? 0) >= min;
            const currentSignature = qualifies ? signature(result) : null;
            if (currentSignature && !seenSignatures[key].has(currentSignature)) {
              addEvent(stats[key], result, candles, idx, kind, idx > splitIndex);
              seenSignatures[key].add(currentSignature);
            }
          }
          const displayMinimum = kind === 'bottom'
            ? BOTTOM_PATTERN_DISPLAY_MIN_QUALITY_SCORE
            : TOP_PATTERN_DISPLAY_MIN_QUALITY_SCORE;
          const displaySignature = signature(result);
          const isFirstDisplayed = Boolean(
            displaySignature &&
            result.displayReady === true &&
            result.patternType &&
            (result.qualityScore ?? 0) >= displayMinimum &&
            !seenDisplaySignatures.has(displaySignature),
          );
          if (isFirstDisplayed && displaySignature && result.patternType) {
            const typeKey = `${kind}:${result.patternType}`;
            typeStats[typeKey] ??= emptyStats();
            addEvent(displayStats[kind], result, candles, idx, kind, idx > splitIndex);
            addEvent(typeStats[typeKey], result, candles, idx, kind, idx > splitIndex);
            seenDisplaySignatures.add(displaySignature);
          }
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
    const targetRate = value.confirmed > 0 ? value.targetFirst / value.confirmed * 100 : 0;
    const stopRate = value.confirmed > 0 ? value.stopFirst / value.confirmed * 100 : 0;
    const trainTargetRate = value.trainConfirmed > 0 ? value.trainTargetFirst / value.trainConfirmed * 100 : 0;
    const testTargetRate = value.testConfirmed > 0 ? value.testTargetFirst / value.testConfirmed * 100 : 0;
    console.log(`${label}: 確認 ${value.confirmed}/${value.events}=${rate.toFixed(1)}%（train ${trainRate.toFixed(1)} / test ${testRate.toFixed(1)}）` +
      `｜確認後目標先 ${targetRate.toFixed(1)}% / 停損先 ${stopRate.toFixed(1)}% / 未決 ${value.unresolved}` +
      `｜目標先 train ${trainTargetRate.toFixed(1)} / test ${testTargetRate.toFixed(1)}`);
  };
  console.log(`${market} symbols=${files.length} lookback=${LOOKBACK_BARS} confirm=${CONFIRM_HORIZON} outcome=${OUTCOME_HORIZON}`);
  for (const kind of ['bottom', 'top'] as const) {
    for (const min of QUALITY_THRESHOLDS) row(`${kind} 品質>=${min}`, stats[`${kind}:${min}`]);
  }
  console.log('\n目前畫面首次顯示的候選結果');
  row('bottom 畫面候選', displayStats.bottom);
  row('top 畫面候選', displayStats.top);
  console.log('\n目前畫面門檻的逐型態結果');
  for (const [type, value] of Object.entries(typeStats).sort((a, b) => b[1].events - a[1].events)) {
    row(type, value);
  }
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
