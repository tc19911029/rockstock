import type { Candle } from '@/types';

export type EntryState = 'can_enter' | 'watch' | 'no_chase';

export interface EntryGateMetrics {
  ma5: number | null;
  ma20: number | null;
  ma60: number | null;
  /** (close - MA20) / MA20, in fraction (0.15 = +15%) */
  deviationMa20: number | null;
  /** (close - MA60) / MA60, in fraction */
  deviationMa60: number | null;
  /** (close - MA5) / MA5 — used to detect "pullback to MA5 not broken" */
  distanceToMa5: number | null;
  /** Number of consecutive limit-up sessions ending at the last bar */
  consecutiveLimitUp: number;
  /** Number of consecutive long-red sessions (>= 5% close) ending at last bar */
  consecutiveLongRed: number;
  /** last_volume / avgVol20 */
  volumeRatio: number | null;
  isLateStageThird: boolean;
}

export interface EntryGateResult {
  state: EntryState;
  reasons: string[];
  metrics: EntryGateMetrics;
}

export interface EntryGateThresholds {
  limitUpPct: number;
  consecutiveLimitUpNoChase: number;
  ma20DeviationNoChase: number;
  ma60DeviationNoChase: number;
  longRedPct: number;
  consecutiveLongRedLateStage: number;
  volumeSurgeRatio: number;
  pullbackBandPct: number;
  belowMa5BreakTolerance: number;
}

export const ENTRY_GATE_THRESHOLDS: EntryGateThresholds = {
  limitUpPct: 0.099,
  consecutiveLimitUpNoChase: 2,
  ma20DeviationNoChase: 0.15,
  ma60DeviationNoChase: 0.25,
  longRedPct: 0.05,
  consecutiveLongRedLateStage: 3,
  volumeSurgeRatio: 2,
  pullbackBandPct: 0.02,
  belowMa5BreakTolerance: 0.005,
};

/** 強多頭模式 — 大盤 5 日 +3% 以上時放寬，避免錯失主升段加碼 */
export const ENTRY_GATE_THRESHOLDS_STRONG_BULL: EntryGateThresholds = {
  ...ENTRY_GATE_THRESHOLDS,
  consecutiveLimitUpNoChase: 3,
  ma20DeviationNoChase: 0.25,
  ma60DeviationNoChase: 0.40,
  consecutiveLongRedLateStage: 4,
  pullbackBandPct: 0.03,
};

function sma(closes: number[], end: number, period: number): number | null {
  if (end < period - 1 || period <= 0) return null;
  let sum = 0;
  for (let i = end - period + 1; i <= end; i++) sum += closes[i];
  return sum / period;
}

function pctChange(prev: number, curr: number): number {
  if (prev <= 0) return 0;
  return (curr - prev) / prev;
}

export function computeEntryState(
  input: { symbol: string; candles: Candle[]; thresholds?: EntryGateThresholds },
): EntryGateResult {
  const { candles } = input;
  const T = input.thresholds ?? ENTRY_GATE_THRESHOLDS;
  const reasons: string[] = [];
  const empty: EntryGateMetrics = {
    ma5: null, ma20: null, ma60: null,
    deviationMa20: null, deviationMa60: null, distanceToMa5: null,
    consecutiveLimitUp: 0, consecutiveLongRed: 0, volumeRatio: null,
    isLateStageThird: false,
  };

  if (!candles || candles.length < 2) {
    reasons.push('K 線資料不足');
    return { state: 'watch', reasons, metrics: empty };
  }

  const last = candles.length - 1;
  const closes = candles.map(c => c.close);
  const volumes = candles.map(c => c.volume);
  const todayClose = closes[last];

  const ma5 = sma(closes, last, 5);
  const ma20 = sma(closes, last, 20);
  const ma60 = sma(closes, last, 60);

  const deviationMa20 = ma20 != null ? (todayClose - ma20) / ma20 : null;
  const deviationMa60 = ma60 != null ? (todayClose - ma60) / ma60 : null;
  const distanceToMa5 = ma5 != null ? (todayClose - ma5) / ma5 : null;

  let consecutiveLimitUp = 0;
  for (let i = last; i >= 1; i--) {
    const change = pctChange(closes[i - 1], closes[i]);
    if (change >= T.limitUpPct) consecutiveLimitUp++;
    else break;
  }

  let consecutiveLongRed = 0;
  for (let i = last; i >= 1; i--) {
    const change = pctChange(closes[i - 1], closes[i]);
    if (change >= T.longRedPct) consecutiveLongRed++;
    else break;
  }

  const avgVol20 = (() => {
    if (last < 20) return null;
    let sum = 0;
    for (let i = last - 19; i <= last; i++) sum += volumes[i];
    return sum / 20;
  })();
  const volumeRatio = avgVol20 != null && avgVol20 > 0 ? volumes[last] / avgVol20 : null;

  const isLateStageThird =
    consecutiveLongRed >= T.consecutiveLongRedLateStage &&
    volumeRatio != null &&
    volumeRatio >= T.volumeSurgeRatio &&
    deviationMa20 != null &&
    deviationMa20 > T.ma20DeviationNoChase;

  const metrics: EntryGateMetrics = {
    ma5, ma20, ma60,
    deviationMa20, deviationMa60, distanceToMa5,
    consecutiveLimitUp, consecutiveLongRed,
    volumeRatio,
    isLateStageThird,
  };

  const noChaseReasons: string[] = [];
  if (consecutiveLimitUp >= T.consecutiveLimitUpNoChase) {
    noChaseReasons.push(`連 ${consecutiveLimitUp} 漲停`);
  }
  if (isLateStageThird) {
    noChaseReasons.push(`末升段（連 ${consecutiveLongRed} 長紅+暴量 ${volumeRatio!.toFixed(1)}x+乖離 +${(deviationMa20! * 100).toFixed(1)}%）`);
  }
  if (deviationMa60 != null && deviationMa60 > T.ma60DeviationNoChase) {
    noChaseReasons.push(`季線乖離 +${(deviationMa60 * 100).toFixed(1)}%`);
  }
  if (deviationMa20 != null && deviationMa20 > T.ma20DeviationNoChase) {
    noChaseReasons.push(`月線乖離 +${(deviationMa20 * 100).toFixed(1)}%`);
  }

  if (noChaseReasons.length > 0) {
    return { state: 'no_chase', reasons: noChaseReasons, metrics };
  }

  if (ma5 != null && distanceToMa5 != null) {
    const within = Math.abs(distanceToMa5) <= T.pullbackBandPct;
    const notBroken = distanceToMa5 >= -T.belowMa5BreakTolerance;
    const aboveMa20 = ma20 == null || todayClose >= ma20;
    if (within && notBroken && aboveMa20) {
      reasons.push(`回測 MA5 不破（距 ${(distanceToMa5 * 100).toFixed(1)}%）`);
      return { state: 'can_enter', reasons, metrics };
    }
  }

  const watchHints: string[] = [];
  if (deviationMa20 != null) watchHints.push(`月線乖離 ${(deviationMa20 * 100).toFixed(1)}%`);
  if (distanceToMa5 != null) watchHints.push(`距 MA5 ${(distanceToMa5 * 100).toFixed(1)}%`);
  return { state: 'watch', reasons: watchHints, metrics };
}

export function entryStateLabel(state: EntryState): string {
  switch (state) {
    case 'can_enter': return '可進';
    case 'watch':     return '觀望';
    case 'no_chase':  return '不可追';
  }
}
