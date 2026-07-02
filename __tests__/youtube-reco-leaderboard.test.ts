/**
 * 老師/節目排行榜聚合測試（recoLeaderboard）。
 *
 * 守門員：
 *   - 主統計只收 scored + filled + 非 conflict
 *   - selStats null 自動過濾（部分 horizon 不足 → n 縮小）
 *   - payoffRatio：無輸家或 n<3 → null
 *   - program_fallback 不進老師表、進節目表
 *   - 節目表按 (stock, date) 去重（同節目兩位老師同日同股只算一次）
 */

import { buildProgramRows, buildTeacherRows } from '@/lib/youtube/recoLeaderboard';
import type { RecoEventWithReturns, RecoReturns } from '@/lib/youtube/recoTypes';

const display = (id: string) => (id === 'src-a' ? '理財達人秀' : id);

function returns(over: Partial<RecoReturns> = {}): RecoReturns {
  return {
    d1: 1, d2: 1.5, d3: 2, d4: 2.5, d5: 3, d10: 4, d20: 5, d60: null,
    mfe: 8, mae: -3,
    excess: { d1: 0.5, d2: 0.7, d3: 1, d4: 1.2, d5: 1.5, d10: 2, d20: 2.5, d60: null },
    isOpen: true,
    lastTrackedDate: '2026-06-11',
    holdReturn: 5,
    holdExcess: 2.5,
    ...over,
  };
}

function event(over: Partial<RecoEventWithReturns>): RecoEventWithReturns {
  return {
    id: `${over.date ?? '2026-06-10'}:${over.teacher ?? '蔡萬得'}:${over.stock_code ?? '2330'}`,
    date: '2026-06-10',
    teacher: '蔡萬得',
    teacher_kind: 'person',
    stock_code: '2330',
    stock_name: '台積電',
    symbol: '2330.TW',
    market: 'TWSE',
    recommendation_type: '看多',
    cohort: 'scored',
    videos: [{
      video_id: 'vid-1', source_id: 'src-a', sentiment: 'bullish',
      recommendation_type: '看多', type_source: 'sentiment_fallback',
      context: '', reason: '', combined_confidence: 0.9,
    }],
    baseline: { status: 'filled', base_date: '2026-06-11', entry_open: 100, mention_close: 99, settled_at: 'x' },
    returns: returns(),
    ...over,
  };
}

describe('buildTeacherRows', () => {
  it('program_fallback 不進老師表', () => {
    const rows = buildTeacherRows([
      event({}),
      event({ teacher: '節目:src-a', teacher_kind: 'program_fallback', stock_code: '2454' }),
    ], display);
    expect(rows).toHaveLength(1);
    expect(rows[0].teacher).toBe('蔡萬得');
  });

  it('主統計排除 conflict / no_fill / watch cohort', () => {
    const rows = buildTeacherRows([
      event({ stock_code: '1101' }),
      event({ stock_code: '1102', conflict: true }),
      event({ stock_code: '1103', baseline: { status: 'no_fill', base_date: '2026-06-11', entry_open: null, mention_close: 99, settled_at: 'x' }, returns: null }),
      event({ stock_code: '1104', cohort: 'watch', recommendation_type: '觀察' }),
    ], display);
    const r = rows[0];
    expect(r.total_events).toBe(4);
    expect(r.scored_events).toBe(1);
    expect(r.watch_events).toBe(1);
    expect(r.unfillable).toBe(1);
    expect(r.byHorizon.d20.n).toBe(1);
  });

  it('horizon null 自動縮 n；d60 未走完 → open_events', () => {
    const rows = buildTeacherRows([
      event({ stock_code: '1101', returns: returns({ d20: 5, d60: null }) }),
      event({ stock_code: '1102', returns: returns({ d20: null, d60: null }) }),
    ], display);
    const r = rows[0];
    expect(r.scored_events).toBe(2);
    expect(r.byHorizon.d20.n).toBe(1);
    expect(r.byHorizon.d60.n).toBe(0);
    expect(r.open_events).toBe(2);
  });

  it('payoffRatio：n<3 → null；有贏有輸 → avg(贏)/|avg(輸)|', () => {
    const small = buildTeacherRows([event({})], display);
    expect(small[0].payoffRatio).toBeNull();

    const rows = buildTeacherRows([
      event({ stock_code: '1101', returns: returns({ d20: 10 }) }),
      event({ stock_code: '1102', returns: returns({ d20: 6 }) }),
      event({ stock_code: '1103', returns: returns({ d20: -4 }) }),
    ], display);
    expect(rows[0].payoffRatio).toBe(2);  // avg(10,6)=8 / |−4|=4
  });

  it('全贏 → payoffRatio null（無輸家不可除）', () => {
    const rows = buildTeacherRows([
      event({ stock_code: '1101', returns: returns({ d20: 10 }) }),
      event({ stock_code: '1102', returns: returns({ d20: 6 }) }),
      event({ stock_code: '1103', returns: returns({ d20: 2 }) }),
    ], display);
    expect(rows[0].payoffRatio).toBeNull();
  });

  it('bestPick = D20 最高的 scored 事件；excessAvgPct 平均', () => {
    const rows = buildTeacherRows([
      event({ stock_code: '1101', stock_name: '甲', returns: returns({ d20: 3, excess: { ...returns().excess, d20: 1 } }) }),
      event({ stock_code: '1102', stock_name: '乙', returns: returns({ d20: 9, excess: { ...returns().excess, d20: 3 } }) }),
    ], display);
    expect(rows[0].bestPick).toMatchObject({ stock_code: '1102', d20: 9 });
    expect(rows[0].byHorizon.d20.excessAvgPct).toBe(2);
  });
});

describe('buildProgramRows', () => {
  it('同節目兩位老師同日同股 → 去重為一筆；program_fallback 計入', () => {
    const rows = buildProgramRows([
      event({ teacher: '蔡萬得' }),
      event({ teacher: '朱家泓' }),  // 同 (2330, 2026-06-10)
      event({ teacher: '節目:src-a', teacher_kind: 'program_fallback', stock_code: '2454' }),
    ], display);
    expect(rows).toHaveLength(1);
    expect(rows[0].source_id).toBe('src-a');
    expect(rows[0].display_name).toBe('理財達人秀');
    expect(rows[0].total_events).toBe(2);  // 2330 去重 + 2454
    expect(rows[0].teachers.sort()).toEqual(['朱家泓', '蔡萬得'].sort());
  });
});
