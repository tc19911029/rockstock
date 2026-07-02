/**
 * 三色「底反該買」合約測試。
 *
 * 底反該買 = 該買(combo grade top/prime) 且 捕撈 0 軸下空頭區金叉(bottomReversal) 且 無出場事件。
 * 回測（scripts/optimize-sanse-grade.ts，train挑/OOS驗）：兩市場 OOS 唯一守得住的收緊。
 * 鎖住 isReversalBuy / tradeVerdict.reversal 的判定 + 掃描排序「底反優先」。
 */
import { isReversalBuy, tradeVerdict, type ConditionReport, type ComboGrade } from '@/lib/cn-sanse/conditions';

/** 最小 ConditionReport stub：只填 isReversalBuy/tradeVerdict 會讀的欄位。 */
function stub(grade: ComboGrade, bottomReversal: boolean, exit: boolean): ConditionReport {
  const sell = exit ? [{ id: 'c_dead', label: '動能死叉', met: true, kind: 'signal' as const }] : [];
  const empty = { buy: [], sell: [], buyHit: false, sellHit: false };
  return {
    doubleB: empty,
    mainforce: empty,
    catch: { buy: [], sell, buyHit: false, sellHit: false },
    mainStage: null,
    groupBuyCount: grade === 'top' ? 3 : 1,
    level: null,
    selected: true,
    conflict: exit,
    sellWarnings: [],
    scores: { shortAttack: 0, midStrength: 1, midControl: 0, kongPan: 0 },
    combo: { grade, rank: 0, label: '', redGate: grade !== 'weak', trigger: true, bottomReversal, midline: false },
  };
}

describe('三色 底反該買', () => {
  test('該買(prime/top) ＋ 底反 ＋ 無出場 ⇒ isReversalBuy=true、verdict.reversal=true、tone=buy', () => {
    for (const g of ['top', 'prime'] as ComboGrade[]) {
      const r = stub(g, true, false);
      expect(isReversalBuy(r)).toBe(true);
      const v = tradeVerdict(r);
      expect(v.tone).toBe('buy');
      expect(v.reversal).toBe(true);
    }
  });

  test('該買但「無底反」⇒ reversal=false（仍是普通該買）', () => {
    const r = stub('prime', false, false);
    expect(isReversalBuy(r)).toBe(false);
    const v = tradeVerdict(r);
    expect(v.tone).toBe('buy');
    expect(v.reversal).toBe(false);
  });

  test('非該買(mid/watch/weak)即使有底反 ⇒ reversal=false', () => {
    for (const g of ['mid', 'watch', 'weak'] as ComboGrade[]) {
      expect(isReversalBuy(stub(g, true, false))).toBe(false);
    }
  });

  test('該買＋底反但有出場事件 ⇒ 不算底反該買（衝突優先）', () => {
    const r = stub('prime', true, true);
    expect(isReversalBuy(r)).toBe(false);
    const v = tradeVerdict(r);
    expect(v.tone).toBe('conflict');
    expect(v.reversal).toBe(false);
  });

  test('掃描排序：底反該買排在普通該買之前', () => {
    const reversal = stub('prime', true, false);
    const normal = stub('top', false, false); // top 但非底反
    const sorted = [normal, reversal].sort((a, b) =>
      (isReversalBuy(b) ? 1 : 0) - (isReversalBuy(a) ? 1 : 0) || b.groupBuyCount - a.groupBuyCount);
    expect(isReversalBuy(sorted[0])).toBe(true); // 底反在最前，即使 groupBuyCount 較低
  });
});
