/**
 * 12 個排序因子定義（2026-04-20 新建）
 *
 * 給 backtest-sort-matrix.ts / backtest-sort-weights.ts 共用。
 * 每個因子給定候選 features，回傳一個排序分數（越大越優先）。
 */

import type { CandleWithIndicators } from '@/types';

export interface CandidateFeatures {
  symbol: string;
  name: string;
  idx: number;
  candles: CandleWithIndicators[];

  // 基礎
  close: number;
  changePercent: number;  // 當日漲幅 %
  volume: number;

  // 排序用衍生因子
  sixConditionsScore: number;  // 0~6（非 A/A_MTF 為 0）
  highWinRateScore: number;    // 0~30
  mtfScore: number;            // 0~4（非 A_MTF 為 0）
  volumeRatio: number;         // 今日量 / 昨日量
  bodyPct: number;             // |close-open|/open
  deviation: number;           // 離 MA20
  mom5: number;                // 5日動能 %
  turnover: number;            // 成交額 = volume*close
  turnoverRate: number;        // 今日量 / 20日均量
  amplitude: number;           // (high-low)/prev.close * 100
  priceStrength: number;       // (close - 20d_low) / (20d_high - 20d_low), 0~1
}

export type SortFactorName =
  | '六條件總分' | '成交額' | '量比' | '動能' | 'K棒實體'
  | '乖離率低' | '漲幅' | '綜合因子' | '高勝率'
  | '換手率' | '振幅' | '價格強度';

export const ALL_SORT_FACTORS: SortFactorName[] = [
  '六條件總分', '成交額', '量比', '動能', 'K棒實體',
  '乖離率低', '漲幅', '綜合因子', '高勝率',
  '換手率', '振幅', '價格強度',
];

export const SORT_DEFS: Record<SortFactorName, (f: CandidateFeatures) => number> = {
  '六條件總分': f => f.sixConditionsScore * 10 + f.changePercent,
  '成交額':     f => Math.log10(Math.max(f.turnover, 1)),
  '量比':       f => Math.min(f.volumeRatio, 5) * 2 + f.changePercent / 10,
  '動能':       f => f.mom5 + f.changePercent / 10,
  'K棒實體':    f => f.bodyPct * 100 + f.changePercent / 10,
  '乖離率低':   f => -f.deviation * 100 + f.changePercent / 10,
  '漲幅':       f => f.changePercent,
  '綜合因子':   f => Math.min(f.volumeRatio, 5) / 5 + Math.max(0, f.mom5) / 20
                   + Math.min(f.bodyPct * 100, 10) / 10 + f.changePercent / 10,
  '高勝率':     f => f.highWinRateScore + f.changePercent / 10,
  '換手率':     f => f.turnoverRate,
  '振幅':       f => f.amplitude,
  '價格強度':   f => f.priceStrength,
};

/** 從一支股票在某日的 candles[idx] 計算所有排序需要的 features */
export function buildFeatures(
  symbol: string,
  name: string,
  candles: CandleWithIndicators[],
  idx: number,
  extra: {
    sixConditionsScore?: number;
    highWinRateScore?: number;
    mtfScore?: number;
    deviation?: number;
  },
): CandidateFeatures | null {
  if (idx < 20 || idx >= candles.length) return null;
  const c = candles[idx];
  const prev = candles[idx - 1];
  if (!c || !prev || prev.close <= 0 || prev.volume <= 0) return null;

  const changePercent = (c.close - prev.close) / prev.close * 100;
  const volumeRatio = c.volume / prev.volume;
  const bodyPct = c.open > 0 ? Math.abs(c.close - c.open) / c.open : 0;
  const mom5 = idx >= 5 && candles[idx - 5].close > 0
    ? (c.close / candles[idx - 5].close - 1) * 100
    : 0;
  const turnover = c.volume * c.close;

  // 20 日均量
  let vol20Sum = 0;
  let vol20Cnt = 0;
  for (let i = Math.max(0, idx - 20); i < idx; i++) {
    if (candles[i].volume > 0) { vol20Sum += candles[i].volume; vol20Cnt++; }
  }
  const avgVol20 = vol20Cnt > 0 ? vol20Sum / vol20Cnt : c.volume;
  const turnoverRate = avgVol20 > 0 ? c.volume / avgVol20 : 1;

  // 振幅（當日 high-low 相對前日收盤）
  const amplitude = prev.close > 0 ? (c.high - c.low) / prev.close * 100 : 0;

  // 價格強度：20 日 high/low
  let hi20 = c.close, lo20 = c.close;
  for (let i = Math.max(0, idx - 19); i <= idx; i++) {
    if (candles[i].high > hi20) hi20 = candles[i].high;
    if (candles[i].low > 0 && candles[i].low < lo20) lo20 = candles[i].low;
  }
  const priceStrength = hi20 > lo20 ? (c.close - lo20) / (hi20 - lo20) : 0.5;

  return {
    symbol, name, idx, candles,
    close: c.close,
    changePercent: +changePercent.toFixed(4),
    volume: c.volume,
    sixConditionsScore: extra.sixConditionsScore ?? 0,
    highWinRateScore:   extra.highWinRateScore   ?? 0,
    mtfScore:           extra.mtfScore           ?? 0,
    volumeRatio:        +volumeRatio.toFixed(4),
    bodyPct:            +bodyPct.toFixed(4),
    deviation:          extra.deviation ?? 0,
    mom5:               +mom5.toFixed(4),
    turnover,
    turnoverRate:       +turnoverRate.toFixed(4),
    amplitude:          +amplitude.toFixed(4),
    priceStrength:      +priceStrength.toFixed(4),
  };
}
