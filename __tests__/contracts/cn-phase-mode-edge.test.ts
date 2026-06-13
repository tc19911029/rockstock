/**
 * 合約：phase×mode edge 凍結（P5）— 改動必須是有意識的（重跑 research 驗證符號穩定 + lift）
 *
 * 只收 train/test 符號跨期一致的格子（2026-06-13 research）。被打臉翻號的格子
 * （打板×修復、低吸×修復）必須維持中性 0，否則就是把 in-sample 雜訊當訊號。
 */

import { phaseModeEdge, applyPhaseModeEdge, PHASE_MODE_EDGE_VERSION } from '@/lib/cn-agents/phaseModeEdge';
import type { CnRecoMode, EmotionStage } from '@/lib/cn-agents/types';

describe('phaseModeEdge 凍結', () => {
  it('版本鎖定 v1', () => {
    expect(PHASE_MODE_EDGE_VERSION).toBe('v1');
  });

  it('低吸 在 啟動/主升/殺跌 加分（跨期穩定正）', () => {
    expect(phaseModeEdge('dixi', 'launch')).toBeGreaterThan(0);
    expect(phaseModeEdge('dixi', 'main_rise')).toBeGreaterThan(0);
    expect(phaseModeEdge('dixi', 'crash')).toBeGreaterThan(0);
  });

  it('打板 在 啟動/主升/分歧/高潮/殺跌 扣分（追板一致虧）', () => {
    for (const p of ['launch', 'main_rise', 'divergence', 'climax', 'crash'] as EmotionStage[]) {
      expect(phaseModeEdge('daban', p)).toBeLessThan(0);
    }
  });

  it('被 train/test 翻號的格子維持中性 0（防 in-sample 過擬合）', () => {
    expect(phaseModeEdge('daban', 'repair')).toBe(0); // 打板×修復 ✗翻
    expect(phaseModeEdge('dixi', 'repair')).toBe(0);   // 低吸×修復 ✗翻
    expect(phaseModeEdge('daban', 'frozen')).toBe(0);  // 冰點樣本不足
  });

  it('applyPhaseModeEdge clamp 0-100 + 四捨五入', () => {
    expect(applyPhaseModeEdge(95, 'dixi', 'launch')).toBe(100); // 95+10 clamp
    expect(applyPhaseModeEdge(5, 'daban', 'climax')).toBe(0);    // 5-10 clamp
    expect(applyPhaseModeEdge(50, 'banlu', 'launch')).toBe(50);  // 半路無 edge
  });

  it('整張表只動有 edge 的 mode（其餘 0）', () => {
    const modes: CnRecoMode[] = ['daban', 'banlu', 'dixi', 'swing', 'watch'];
    const phases: EmotionStage[] = ['frozen', 'repair', 'launch', 'main_rise', 'climax', 'divergence', 'retreat', 'crash'];
    let nonZero = 0;
    for (const m of modes) for (const p of phases) if (phaseModeEdge(m, p) !== 0) nonZero++;
    // dixi 3 + daban 5 + watch 5 = 13
    expect(nonZero).toBe(13);
  });
});
