import { buildStageTable, buildModePhaseCrossTable } from '@/lib/cn-agents/backtest/crossTable';
import type { CnRecoEventWithReturns } from '@/lib/cn-agents/backtest/recoPipeline';
import type { RecoReturns } from '@/lib/backtest/eventReturns';

function ret(d5: number): RecoReturns {
  return {
    d1: 1, d2: 1, d3: 1, d4: 1, d5, d10: 1, d20: 1, d60: null,
    mfe: 5, mae: -2, excess: { d1: 0, d2: 0, d3: 0, d4: 0, d5: 0, d10: 0, d20: 0, d60: null },
    isOpen: false, lastTrackedDate: '2026-06-10', holdReturn: d5, holdExcess: 0,
  };
}
function ev(phase: string, mode: string, d5: number): CnRecoEventWithReturns {
  return {
    id: `x:hard_score_v0:000001`, date: '2026-06-05', agentSource: 'hard_score_v0',
    code: '000001', name: 'X', symbol: '000001.SZ', board: 'SZ-main',
    tier: 'A', mode: mode as never, totalScore: 70, scoreBreakdown: {},
    sentimentPhase: phase as never, reason: '', baseline: { status: 'filled', base_date: '2026-06-06', entry_open: 10, mention_close: 10, settled_at: 'x' },
    returns: ret(d5),
  };
}

describe('crossTable 新口徑', () => {
  it('buildStageTable 八階段全列、成功率 = d5>+3% 比例', () => {
    const events = [ev('main_rise', 'daban', 5), ev('main_rise', 'daban', 1), ev('repair', 'dixi', 4)];
    const t = buildStageTable(events);
    expect(t.length).toBe(8); // 八階段固定全列
    const mr = t.find((r) => r.phase === 'main_rise')!;
    expect(mr.filled).toBe(2);
    expect(mr.successRate).toBeCloseTo(0.5, 2); // 一個 d5=5(成功) 一個 d5=1(不) → 0.5
    expect(mr.winRate.d2).not.toBeNull();
    // 沒事件的階段 n=0、率 null
    const crash = t.find((r) => r.phase === 'crash')!;
    expect(crash.filled).toBe(0);
    expect(crash.successRate).toBeNull();
  });

  it('成功率/勝率皆 ∈ [0,1] 或 null', () => {
    const t = buildStageTable([ev('launch', 'dixi', 10), ev('launch', 'dixi', -5)]);
    for (const r of t) {
      for (const v of [r.successRate, r.winRate.d1, r.winRate.d5]) {
        expect(v === null || (v >= 0 && v <= 1)).toBe(true);
      }
    }
  });

  it('modePhase 排除 tier C', () => {
    const c = { ...ev('main_rise', 'daban', 5), tier: 'C' as const };
    expect(buildModePhaseCrossTable([c]).length).toBe(0);
  });
});
