/**
 * phase×mode edge 校準（P5）— 把回測實證的「打法×情緒階段」邊際接回評分
 *
 * 來源：scripts/research-cn-phase-mode-edge.ts 的 train(舊60%)/test(新40%) 切分（2026-06-13）。
 * **只收「符號跨期一致」的格子**（train/test 同號且各 n≥8），magnitude 用固定值不擬合幅度
 * → 降 overfit。被 train/test 打臉翻號的格子（如 打板×修復、低吸×修復）刻意**不收**。
 *
 * 凍結結論（d5 超額 vs 上證）：
 *   ✓ 低吸(dixi) × {啟動,主升,殺跌} 跨期穩定正 → +EDGE
 *   ✓ 打板(daban) × {啟動,主升,分歧,高潮,殺跌} 跨期穩定負（追板一致虧）→ −EDGE
 *   ✓ 觀察(watch) × {啟動,主升,分歧,高潮,殺跌} 穩定負（避開判斷對）→ −EDGE
 *
 * ⚠️ 改這表必須先重跑 research-cn-phase-mode-edge.ts 確認符號仍穩定，
 *    再跑 research-cn-edge-liftcheck.ts 確認 test 半段 top-N 超額真的被拉高（out-of-sample）。
 *    改完同步 phase-mode-edge 合約測試的凍結 snapshot。
 */

import type { CnRecoMode, EmotionStage } from './types';

/** 固定邊際值（分；±10 足以重排但不暴力） */
const EDGE = 10;

export const PHASE_MODE_EDGE_VERSION = 'v1';

/** (mode, phase) → 分數調整；查不到 = 0（中性，含被 train/test 翻號剔除的格子） */
const TABLE: Partial<Record<CnRecoMode, Partial<Record<EmotionStage, number>>>> = {
  dixi: { launch: +EDGE, main_rise: +EDGE, crash: +EDGE },
  daban: { launch: -EDGE, main_rise: -EDGE, divergence: -EDGE, climax: -EDGE, crash: -EDGE },
  watch: { launch: -EDGE, main_rise: -EDGE, divergence: -EDGE, climax: -EDGE, crash: -EDGE },
};

/** 回傳該 (mode, phase) 的分數調整（無穩定 edge → 0）。 */
export function phaseModeEdge(mode: CnRecoMode, phase: EmotionStage): number {
  return TABLE[mode]?.[phase] ?? 0;
}

/** 套用 edge 並 clamp 0-100。 */
export function applyPhaseModeEdge(score: number, mode: CnRecoMode, phase: EmotionStage): number {
  return Math.min(100, Math.max(0, Math.round(score + phaseModeEdge(mode, phase))));
}
