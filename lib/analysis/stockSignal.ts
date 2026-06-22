/**
 * 個股「六大進場條件 + 趨勢」即時判讀（純函式，台股／陸股共用單一事實）— 2026-06-20
 *
 * 給題材分類頁的「六條件徽章 + 只看多頭篩選」用（純顯示層，不參與選股 鐵則 #5）。
 * 六條件邏輯一律走掃描器同一支 evaluateSixConditions（lib/analysis/trendAnalysis）+ BASE_THRESHOLDS，
 * 不在這裡也不在 UI hard-code 任何門檻（鐵則 #10）。
 */
import type { Candle } from '@/types';
import { computeIndicators } from '@/lib/indicators';
import { evaluateSixConditions } from '@/lib/analysis/trendAnalysis';
import { BASE_THRESHOLDS } from '@/lib/strategy/StrategyConfig';

export interface StockSignal {
  six: number;      // 0–6 總分
  core: number;     // 0–5 核心分（前 5 條必要條件）
  ready: boolean;   // 核心 5 條全過 = 符合進場條件
  trend: '多頭' | '空頭' | '盤整';
  pos: string;      // 趨勢位置（多頭上升段 / 接近壓力區 …）
}

/**
 * 由日K（升冪 OHLCV）算六條件 + 趨勢。
 * @param rawCandles 升冪排列的原始日K（需含 volume，量條件才有效）
 * @param asOfDate   以哪天當最後一根（不帶 → 用最後一根）；停牌無 bar 時取最後一根 ≤ asOf
 * @returns 不足 30 根或定位不到 → null
 */
export function evaluateStockSignal(rawCandles: Candle[], asOfDate?: string): StockSignal | null {
  if (!rawCandles?.length || rawCandles.length < 30) return null;

  let idx = rawCandles.length - 1;
  if (asOfDate) {
    idx = -1;
    for (let i = rawCandles.length - 1; i >= 0; i--) {
      if (rawCandles[i].date <= asOfDate) { idx = i; break; }
    }
  }
  if (idx < 20) return null;

  const candles = computeIndicators(rawCandles);
  const r = evaluateSixConditions(candles, idx, BASE_THRESHOLDS);
  return {
    six: r.totalScore,
    core: r.coreScore,
    ready: r.isCoreReady,
    trend: r.trend.state,
    pos: r.position.stage,
  };
}
