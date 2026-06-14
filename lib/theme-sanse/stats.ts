// ============================================================
// 題材×三色 — 三組 cohort 統計（純函式）。
//
// 比照 lib/cn-agents/backtest/crossTable.ts 的 aggregate（winRate/avg/excessAvg/
// lowSample），加使用者指定的延伸：median（中位數漲幅）、maxGain（平均 MFE）、
// maxDrawdown（平均 MAE）、profitFactor（賺賠比，d5）。三組用同一套數學 → 可比。
//
// winRate 只算 baseline=filled 且該 horizon 非 null 的事件；no_fill（一字買不到）/
// no_data / pending 單獨列。報酬由 caller 用 computeEventReturns 即時 derive 後傳入。
// ============================================================

import type { RecoReturns } from '@/lib/backtest/eventReturns';
import type { Cohort, ThemeSanseEvent, TsMarket } from './types';

export const LOW_SAMPLE_N = 10;

// 推薦後第 1,2,3,4,5,10,20 個交易日（與 cn-agents / youtube 口徑一致）
export const TS_WIN_HORIZONS = ['d1', 'd2', 'd3', 'd4', 'd5'] as const;
export const TS_AVG_HORIZONS = ['d1', 'd2', 'd3', 'd4', 'd5', 'd10', 'd20'] as const;
export type TsWinHorizon = (typeof TS_WIN_HORIZONS)[number];
export type TsAvgHorizon = (typeof TS_AVG_HORIZONS)[number];

export interface ThemeSanseEventWithReturns extends ThemeSanseEvent {
  returns: RecoReturns | null;
}

export interface CohortStats {
  cohort: Cohort;
  n: number;
  filled: number;
  unfillable: number;   // no_fill（一字鎖死買不到）
  noData: number;
  pending: number;
  winRate: Record<TsWinHorizon, number | null>;
  avg: Record<TsAvgHorizon, number | null>;
  median: Record<TsAvgHorizon, number | null>;
  maxGain: number | null;       // 平均 MFE（最大有利波動）
  maxDrawdown: number | null;   // 平均 MAE（最大不利波動；越負越深）
  profitFactor: number | null;  // d5 賺賠比 = Σ正報酬 / |Σ負報酬|
  excessAvg: number | null;     // d5 對指數超額平均
  lowSample: boolean;
}

const round2 = (x: number): number => +x.toFixed(2);

function median(vals: number[]): number | null {
  if (vals.length === 0) return null;
  const s = [...vals].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return round2(s.length % 2 === 0 ? (s[mid - 1] + s[mid]) / 2 : s[mid]);
}

const mean = (vals: number[]): number | null =>
  vals.length > 0 ? round2(vals.reduce((a, b) => a + b, 0) / vals.length) : null;

/** 聚合一組 cohort 的統計。 */
export function aggregateCohort(cohort: Cohort, events: ThemeSanseEventWithReturns[]): CohortStats {
  const filled = events.filter((e) => e.baseline?.status === 'filled');
  const horizonVals = (h: TsWinHorizon | TsAvgHorizon): number[] =>
    filled.map((e) => e.returns?.[h]).filter((v): v is number => v != null);

  const winRate = {} as Record<TsWinHorizon, number | null>;
  for (const h of TS_WIN_HORIZONS) {
    const vals = horizonVals(h);
    winRate[h] = vals.length > 0 ? round2(vals.filter((v) => v > 0).length / vals.length) : null;
  }
  const avg = {} as Record<TsAvgHorizon, number | null>;
  const med = {} as Record<TsAvgHorizon, number | null>;
  for (const h of TS_AVG_HORIZONS) {
    const vals = horizonVals(h);
    avg[h] = mean(vals);
    med[h] = median(vals);
  }

  const d5 = horizonVals('d5');
  const gains = d5.filter((v) => v > 0).reduce((a, b) => a + b, 0);
  const losses = Math.abs(d5.filter((v) => v < 0).reduce((a, b) => a + b, 0));
  const profitFactor = losses > 0 ? round2(gains / losses) : null; // 無虧損樣本 → null（不報 Infinity）

  const mfeVals = filled.map((e) => e.returns?.mfe).filter((v): v is number => v != null);
  const maeVals = filled.map((e) => e.returns?.mae).filter((v): v is number => v != null);
  const excessVals = filled.map((e) => e.returns?.excess?.d5).filter((v): v is number => v != null);

  return {
    cohort,
    n: events.length,
    filled: filled.length,
    unfillable: events.filter((e) => e.baseline?.status === 'no_fill').length,
    noData: events.filter((e) => e.baseline?.status === 'no_data').length,
    pending: events.filter((e) => !e.baseline || e.baseline.status === 'pending').length,
    winRate,
    avg,
    median: med,
    maxGain: mean(mfeVals),
    maxDrawdown: mean(maeVals),
    profitFactor,
    excessAvg: mean(excessVals),
    lowSample: filled.length < LOW_SAMPLE_N,
  };
}

// ── 三組對照快照（cron 預算、UI 即時讀；?live=1 才重算） ─────────────────────

export interface CohortComparisonSnapshot {
  schemaVersion: number;
  market: TsMarket;
  builtAt: string;
  days: number;
  asOf: string | null;
  cohorts: { cross: CohortStats; theme: CohortStats; sanse: CohortStats };
  meta: {
    totalEvents: number;
    lowSampleN: number;
    /** cross 事件中題材熱度來自重建來源（degraded）的比例；TW 恆 0 */
    degradedThemeShare: number | null;
    note: string;
  };
}
