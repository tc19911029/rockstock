import { answerBelongsToRun, makeRunId, selectCurrentRunContext } from '@/lib/agents/orchestrator';

describe('agent run isolation', () => {
  test('只接受目前 runId 的答案', () => {
    expect(answerBelongsToRun({ runId: 'run-new' }, 'run-new')).toBe(true);
    expect(answerBelongsToRun({ runId: 'run-old' }, 'run-new')).toBe(false);
    expect(answerBelongsToRun({}, 'run-new')).toBe(false);
    expect(answerBelongsToRun(null, 'run-new')).toBe(false);
  });

  test('未提供 runId 時維持歷史查詢相容性', () => {
    expect(answerBelongsToRun({ runId: 'run-old' })).toBe(true);
    expect(answerBelongsToRun({})).toBe(true);
  });

  test('相同掃描來源重新 prepare 仍產生不同 runId', () => {
    const sourceTime = '2026-08-17T08:00:00.000Z';
    const first = makeRunId('2026-08-17', '2330.TW', sourceTime);
    const second = makeRunId('2026-08-17', '2330.TW', sourceTime);
    expect(first).not.toBe(second);
    expect(first).toContain('20260817080000');
  });

  test('meta/phase 半寫狀態選擇較新的 run', () => {
    const base = {
      schemaVersion: 1 as const,
      date: '2026-08-17', symbol: '2330.TW', market: 'TW' as const,
    };
    const meta = { ...base, runId: 'old', strategyId: 'old-strategy', startedAt: '2026-08-17T08:00:00Z' };
    const phase = {
      ...base, runId: 'new', strategyId: 'new-strategy', startedAt: '2026-08-17T08:01:00Z',
      currentPhase: 1 as const, completed: {},
    };
    expect(selectCurrentRunContext(meta, phase)).toEqual({
      runId: 'new', strategyId: 'new-strategy',
    });
  });
});
