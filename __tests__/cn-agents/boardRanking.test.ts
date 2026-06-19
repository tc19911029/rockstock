/**
 * 陸股板塊排行純函式單元測試 — classifyBoardStage / computeBoardRotation
 *
 * 守：階段 heuristic 的優先序與邊界、輪動名次以 5 日漲幅排 + 分桶門檻（±3）+ 無 prior 行為。
 * （顯示層，不參與選股；改 heuristic/門檻時這裡會紅，提醒同步說明文案。）
 */
import { classifyBoardStage, computeBoardRotation } from '../../lib/cn-agents/boardRanking';
import type { BoardEntry } from '../../lib/cn-agents/types';

function board(code: string, pct: number, pct5d: number | null, rank = 0): BoardEntry {
  return {
    code, name: code, kind: 'concept', pct, turnoverCny: null, mainNetCny: null,
    upCount: null, downCount: null, leaderSymbol: null, leaderName: null, leaderPct: null,
    limitUpCount: null, rank, pct5d,
  };
}

describe('classifyBoardStage', () => {
  it('退潮：近 5 日轉弱（pct5d ≤ -3）優先於一切', () => {
    expect(classifyBoardStage({ pct: 5, pct5d: -4 })).toBe('退潮'); // 今天大漲也算退潮
  });
  it('高潮噴出：pct5d ≥ 8 且今天還在衝（pct ≥ 2）', () => {
    expect(classifyBoardStage({ pct: 3, pct5d: 10 })).toBe('高潮噴出');
  });
  it('高潮門檻但今天沒衝 → 主升段', () => {
    expect(classifyBoardStage({ pct: 0.5, pct5d: 10 })).toBe('主升段');
  });
  it('主升段：pct5d ≥ 4 且 pct > 0', () => {
    expect(classifyBoardStage({ pct: 1, pct5d: 5 })).toBe('主升段');
  });
  it('剛啟動：pct5d ∈ [1.5,4) 且 pct ≥ 0.5', () => {
    expect(classifyBoardStage({ pct: 1, pct5d: 2 })).toBe('剛啟動');
  });
  it('盤整：其餘', () => {
    expect(classifyBoardStage({ pct: 0.2, pct5d: 0.5 })).toBe('盤整');
  });
  it('pct5d 缺值 → 只看今日 pct 粗分', () => {
    expect(classifyBoardStage({ pct: 3, pct5d: null })).toBe('剛啟動');
    expect(classifyBoardStage({ pct: -3, pct5d: null })).toBe('退潮');
    expect(classifyBoardStage({ pct: 0.5, pct5d: null })).toBe('盤整');
  });
});

describe('computeBoardRotation', () => {
  // 今日 5 日漲幅排名：A(10)→1, B(5)→2, C(1)→3
  const today = [board('A', 0, 10), board('B', 0, 5), board('C', 0, 1)];

  it('無 prior → 全部 rankDelta=null、bucket=mid，rankNow 仍照 5 日漲幅排', () => {
    const m = computeBoardRotation(today, null);
    expect(m.get('A')).toMatchObject({ rankNow: 1, rankPrev: null, rankDelta: null, bucket: 'mid' });
    expect(m.get('C')!.rankNow).toBe(3);
  });

  it('名次爬升 ≥3 → 轉入(in)；下掉 ≥3 → 轉出(out)', () => {
    // prior 名次：C(20)→1, B(8)→2, A(2)→3 ；今日 A→1(爬2)?，需要差≥3 才 in
    // 造一個 A 大幅爬升、C 大幅下掉的場景：
    const prior = [
      board('C', 0, 20), board('X1', 0, 19), board('X2', 0, 18),
      board('X3', 0, 17), board('A', 0, 2), board('B', 0, 1),
    ];
    const todayBig = [
      board('A', 0, 30), board('B', 0, 9), board('X1', 0, 8),
      board('X2', 0, 7), board('X3', 0, 6), board('C', 0, 5),
    ];
    const m = computeBoardRotation(todayBig, prior);
    // A: prior rank 5 → now 1，delta=+4 ≥3 → in
    expect(m.get('A')).toMatchObject({ rankNow: 1, rankPrev: 5, rankDelta: 4, bucket: 'in' });
    // C: prior rank 1 → now 6，delta=-5 ≤-3 → out
    expect(m.get('C')).toMatchObject({ rankNow: 6, rankPrev: 1, rankDelta: -5, bucket: 'out' });
  });

  it('名次小變動（±2 內）→ 主流(mid)', () => {
    const prior = [board('A', 0, 11), board('B', 0, 6), board('C', 0, 2)];
    const m = computeBoardRotation(today, prior); // 名次都沒變
    expect(m.get('A')!.bucket).toBe('mid');
    expect(m.get('B')!.bucket).toBe('mid');
  });

  it('pct5d 缺值排序沉底', () => {
    const t = [board('A', 0, 5), board('B', 0, null), board('C', 0, 3)];
    const m = computeBoardRotation(t, null);
    expect(m.get('A')!.rankNow).toBe(1);
    expect(m.get('C')!.rankNow).toBe(2);
    expect(m.get('B')!.rankNow).toBe(3); // null 沉底
  });
});
