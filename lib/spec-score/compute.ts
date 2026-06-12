/**
 * specScore 純計算（2026-06-12 A3）
 *
 * total = Σ(score_d × w_d) / Σ(w_d, 只取有資料的維度)，coverage = 已覆蓋權重占比。
 * 缺資料的維度【不入分也不扣分】（規格書盲點修正：缺值處理明確化 —
 * 4 套類型權重下缺「報價趨勢」的記憶體股不可被系統性壓分）。
 */
import { SPEC_WEIGHTS, type SpecDim, type SpecStockType } from './weights';

export interface SpecDimInput {
  /** 0-100；null = 該維度無資料（不入分） */
  score: number | null;
  /** 顯示用一句話（例如「主升段」「強多」） */
  note?: string;
}

export type SpecScoreInputs = Partial<Record<SpecDim, SpecDimInput>>;

export interface SpecScoreResult {
  /** 0-100（covered 維度加權歸一）；全缺 = null */
  total: number | null;
  stockType: SpecStockType;
  /** 已覆蓋權重 / 全部權重（0-1，顯示用 — 低覆蓋的分數要打折看） */
  coverage: number;
  /** 各維度明細（含缺資料維度，score=null） */
  dims: Array<{ dim: SpecDim; weight: number; score: number | null; note?: string }>;
}

export function computeSpecScore(stockType: SpecStockType, inputs: SpecScoreInputs): SpecScoreResult {
  const weights = SPEC_WEIGHTS[stockType];
  const dims: SpecScoreResult['dims'] = [];
  let weightedSum = 0;
  let coveredWeight = 0;
  let totalWeight = 0;

  for (const [dim, weight] of Object.entries(weights) as Array<[SpecDim, number]>) {
    totalWeight += weight;
    const input = inputs[dim];
    const score = input?.score ?? null;
    dims.push({ dim, weight, score, ...(input?.note ? { note: input.note } : {}) });
    if (score != null) {
      weightedSum += score * weight;
      coveredWeight += weight;
    }
  }

  return {
    total: coveredWeight > 0 ? Math.round(weightedSum / coveredWeight) : null,
    stockType,
    coverage: totalWeight > 0 ? +(coveredWeight / totalWeight).toFixed(2) : 0,
    dims,
  };
}
