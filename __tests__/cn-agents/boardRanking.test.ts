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

describe('computeBoardRotation（日線：依今日漲幅 pct 排，比昨天）', () => {
  // 今日漲幅排名：A(10)→1, B(5)→2, C(1)→3
  const today = [board('A', 10, 0), board('B', 5, 0), board('C', 1, 0)];

  it('無 prior → 全部 rankDelta=null、bucket=mid，rankNow 照今日漲幅排', () => {
    const m = computeBoardRotation(today, null);
    expect(m.get('A')).toMatchObject({ rankNow: 1, rankPrev: null, rankDelta: null, bucket: 'mid' });
    expect(m.get('C')!.rankNow).toBe(3);
  });

  it('名次爬升 ≥3 → 轉入(in)；下掉 ≥3 → 轉出(out)', () => {
    // 昨天 → 今天，依今日漲幅 pct 排名；造 A 大幅爬升、C 大幅下掉
    const prior = [
      board('C', 20, 0), board('X1', 19, 0), board('X2', 18, 0),
      board('X3', 17, 0), board('A', 2, 0), board('B', 1, 0),
    ];
    const todayBig = [
      board('A', 30, 0), board('B', 9, 0), board('X1', 8, 0),
      board('X2', 7, 0), board('X3', 6, 0), board('C', 5, 0),
    ];
    const m = computeBoardRotation(todayBig, prior);
    // A: 昨 rank 5 → 今 1，delta=+4 ≥3 → in
    expect(m.get('A')).toMatchObject({ rankNow: 1, rankPrev: 5, rankDelta: 4, bucket: 'in' });
    // C: 昨 rank 1 → 今 6，delta=-5 ≤-3 → out
    expect(m.get('C')).toMatchObject({ rankNow: 6, rankPrev: 1, rankDelta: -5, bucket: 'out' });
  });

  it('名次小變動（±2 內）→ 主流(mid)', () => {
    const prior = [board('A', 11, 0), board('B', 6, 0), board('C', 2, 0)];
    const m = computeBoardRotation(today, prior); // 名次都沒變
    expect(m.get('A')!.bucket).toBe('mid');
    expect(m.get('B')!.bucket).toBe('mid');
  });
});
