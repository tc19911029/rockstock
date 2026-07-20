import type { Candle } from '@/types';
import {
  ENTRY_GATE_THRESHOLDS,
  ENTRY_GATE_THRESHOLDS_STRONG_BULL,
  type EntryGateThresholds,
} from './entryGate';

export type MarketRegime = 'strong_bull' | 'normal' | 'bear';

export interface RegimeDetectResult {
  regime: MarketRegime;
  reasons: string[];
  metrics: {
    closeVsMa20: number | null;
    closeVsMa60: number | null;
    fiveDayReturn: number | null;
    ma20VsMa60: number | null;
  };
}

export const REGIME_THRESHOLDS = {
  strongBullFiveDay: 0.03,
  bearBelowMa20Days: 5,
} as const;

function sma(closes: number[], end: number, period: number): number | null {
  if (end < period - 1 || period <= 0) return null;
  let sum = 0;
  for (let i = end - period + 1; i <= end; i++) sum += closes[i];
  return sum / period;
}

export function detectMarketRegime(indexCandles: Candle[] | null | undefined): RegimeDetectResult {
  const empty: RegimeDetectResult = {
    regime: 'normal',
    reasons: ['資料不足'],
    metrics: { closeVsMa20: null, closeVsMa60: null, fiveDayReturn: null, ma20VsMa60: null },
  };
  if (!indexCandles || indexCandles.length < 60) return empty;

  const closes = indexCandles.map(c => c.close);
  const last = closes.length - 1;
  const todayClose = closes[last];
  const ma20 = sma(closes, last, 20);
  const ma60 = sma(closes, last, 60);
  if (ma20 == null || ma60 == null) return empty;

  const closeVsMa20 = (todayClose - ma20) / ma20;
  const closeVsMa60 = (todayClose - ma60) / ma60;
  const ma20VsMa60 = (ma20 - ma60) / ma60;
  const fiveAgo = last >= 5 ? closes[last - 5] : closes[0];
  const fiveDayReturn = (todayClose - fiveAgo) / fiveAgo;

  const metrics = { closeVsMa20, closeVsMa60, fiveDayReturn, ma20VsMa60 };

  const reasons: string[] = [];
  const strongBull =
    closeVsMa20 > 0 &&
    closeVsMa60 > 0 &&
    ma20VsMa60 > 0 &&
    fiveDayReturn > REGIME_THRESHOLDS.strongBullFiveDay;

  if (strongBull) {
    reasons.push(`大盤 5 日 +${(fiveDayReturn * 100).toFixed(1)}%`);
    reasons.push(`收 > MA20（+${(closeVsMa20 * 100).toFixed(1)}%）`);
    reasons.push(`收 > MA60（+${(closeVsMa60 * 100).toFixed(1)}%）`);
    reasons.push('MA20 > MA60（多頭排列）');
    return { regime: 'strong_bull', reasons, metrics };
  }

  const bear = closeVsMa20 < 0 && ma20VsMa60 < 0;
  if (bear) {
    reasons.push(`收 < MA20（${(closeVsMa20 * 100).toFixed(1)}%）`);
    reasons.push('MA20 < MA60（空頭排列）');
    return { regime: 'bear', reasons, metrics };
  }

  reasons.push('盤整 / 過渡（未達強多頭也未達空頭）');
  return { regime: 'normal', reasons, metrics };
}

export function regimeLabel(regime: MarketRegime): string {
  switch (regime) {
    case 'strong_bull': return '強多頭';
    case 'normal':      return '盤整';
    case 'bear':        return '空頭';
  }
}

/** 把 regime 對應到 entryGate thresholds — 強多頭時放寬避免錯失主升段加碼 */
export function thresholdsForRegime(regime: MarketRegime): EntryGateThresholds {
  switch (regime) {
    case 'strong_bull': return ENTRY_GATE_THRESHOLDS_STRONG_BULL;
    case 'normal':
    case 'bear':
    default:            return ENTRY_GATE_THRESHOLDS;
  }
}

/**
 * ⚠️ 2026-07-20 第七輪查核紀錄（**刻意不改，留給使用者裁決**）：
 * 上面的 `bear` 與 `normal` 回同一組門檻 → **大盤翻空時 regime 驅動的門檻收緊實際上是 no-op**。
 * 課程 CH5-6 成數表（多頭8成/盤整5成/空頭3成）目前只由 positionSizer.regimeExposureCap 承接，
 * 而它只在單筆下單試算（/api/portfolio/size-suggestion）時被呼叫，不進每日建議鏈。
 *
 * 為什麼不逕自加一組 ENTRY_GATE_THRESHOLDS_BEAR：
 * 那是**收緊進場 gate**，依 CLAUDE.md 誠實 edge 紀律必須先過 compute-honest-edge 且 train/test 一致。
 * 本輪已改的是提示層（composeOperationSuggestion 帶入 regime 文案），不動 gate。
 */
