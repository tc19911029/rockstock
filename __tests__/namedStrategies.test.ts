/**
 * 三色具名策略（namedStrategies）單元測試
 *
 * 保證：五個策略的判定衍生自既有 ConditionReport、正確、且
 *  - 「紅+雙B金叉」只認 b_gold；「紅+雙B金叉或突破」金叉 OR 突破皆可（OR 行為）
 *  - 「紅+黃+觸發」要紅、黃同時 >0 且有一個觸發
 *  - 全共振⭐ = groupBuyCount===3；底反🔥 = 沿用 isReversalBuy（grade top/prime + 0軸下金叉 + 無賣訊）
 */
import { NAMED_STRATEGIES, matchedStrategies, getStrategy } from '../lib/cn-sanse/namedStrategies';
import type { Cond, GroupReport, ConditionReport, ComboGrade } from '../lib/cn-sanse/conditions';

const sig = (id: string, met: boolean): Cond => ({ id, label: id, met, kind: 'signal' });
const st = (id: string, met: boolean): Cond => ({ id, label: id, met, kind: 'state' });
const grp = (buy: Cond[], sell: Cond[] = []): GroupReport => ({
  buy, sell,
  buyHit: buy.some((c) => c.kind === 'signal' && c.met),
  sellHit: sell.some((c) => c.kind === 'signal' && c.met),
});

interface Opts {
  red?: number; yellow?: number; purple?: number;   // 三色分數（>0 = 亮）
  bGold?: boolean; bBreak?: boolean;                  // 雙B 金叉 / 突破
  cGold?: boolean; cBear?: boolean;                   // 捕撈金叉 / 0軸下底反
  mainBuy?: boolean;                                  // 主力買訊（m_stage）
  grade?: ComboGrade;                                 // combo 評級（給底反用）
  bottomReversal?: boolean;
  catchSell?: boolean;                                // 捕撈賣訊（測底反被賣訊否決）
}
function mkReport(o: Opts): ConditionReport {
  const red = o.red ?? 0, yellow = o.yellow ?? 0, purple = o.purple ?? 0;
  const doubleB = grp(
    [sig('b_gold', !!o.bGold), sig('b_break', !!o.bBreak), sig('b_resonance', !!(o.bGold && o.bBreak))],
    [sig('b_dead', false)],
  );
  const catchG = grp(
    [sig('c_gold', !!o.cGold), st('c_gold_bear', !!o.cBear)],
    [sig('c_dead', !!o.catchSell)],
  );
  const mainforce = grp([sig('m_stage', !!o.mainBuy)], [sig('m_weak', false)]);
  const groupBuyCount = [doubleB.buyHit, mainforce.buyHit, catchG.buyHit].filter(Boolean).length;
  const redOn = red > 0;
  return {
    doubleB, mainforce, catch: catchG, mainStage: o.mainBuy ? 'develop' : null,
    groupBuyCount, level: null, selected: groupBuyCount >= 1, conflict: false, sellWarnings: [],
    scores: { shortAttack: purple, midStrength: red, midControl: yellow, kongPan: 0 },
    combo: {
      grade: o.grade ?? (groupBuyCount === 3 ? 'top' : redOn ? 'prime' : 'weak'),
      rank: 0, label: '', redGate: redOn,
      trigger: doubleB.buyHit || catchG.buyHit,
      bottomReversal: !!o.bottomReversal, midline: redOn && yellow > 0,
    },
  };
}
const ids = (r: ConditionReport) => matchedStrategies(r).map((s) => s.id);

describe('namedStrategies', () => {
  it('registry 五個策略、id 唯一', () => {
    expect(NAMED_STRATEGIES).toHaveLength(5);
    expect(new Set(NAMED_STRATEGIES.map((s) => s.id)).size).toBe(5);
    expect(getStrategy('reversal')?.label).toContain('底反');
  });

  it('全共振⭐ = 三組買訊同時（groupBuyCount===3）', () => {
    const r = mkReport({ red: 2, yellow: 2, purple: 2, bGold: true, cGold: true, mainBuy: true });
    expect(ids(r)).toContain('resonance');
    // 只兩組 → 不算共振
    const r2 = mkReport({ red: 2, bGold: true, cGold: true });
    expect(ids(r2)).not.toContain('resonance');
  });

  it('紅+黃+觸發 = 紅且黃且有一個觸發', () => {
    expect(ids(mkReport({ red: 2, yellow: 2, cGold: true }))).toContain('red_yellow_trigger');
    expect(ids(mkReport({ red: 2, yellow: 2, bBreak: true }))).toContain('red_yellow_trigger');
    expect(ids(mkReport({ red: 2, yellow: 0, cGold: true }))).not.toContain('red_yellow_trigger'); // 缺黃
    expect(ids(mkReport({ red: 2, yellow: 2 }))).not.toContain('red_yellow_trigger');               // 缺觸發
  });

  it('紅+雙B金叉 只認 b_gold；突破不算', () => {
    expect(ids(mkReport({ red: 2, bGold: true }))).toContain('red_dualb_gold');
    expect(ids(mkReport({ red: 2, bBreak: true }))).not.toContain('red_dualb_gold');  // 只突破 → 不算金叉
    expect(ids(mkReport({ red: 0, bGold: true }))).not.toContain('red_dualb_gold');   // 無紅
  });

  it('紅+雙B金叉或突破 = 金叉 OR 突破皆可', () => {
    expect(ids(mkReport({ red: 2, bGold: true }))).toContain('red_dualb_any');
    expect(ids(mkReport({ red: 2, bBreak: true }))).toContain('red_dualb_any');       // 突破也算
    expect(ids(mkReport({ red: 0, bBreak: true }))).not.toContain('red_dualb_any');   // 無紅
  });

  it('底反🔥 沿用 isReversalBuy：grade top/prime + 0軸下底反 + 無賣訊', () => {
    const ok = mkReport({ red: 2, cGold: true, cBear: true, bottomReversal: true, grade: 'prime' });
    expect(ids(ok)).toContain('reversal');
    // 有捕撈賣訊 → 否決
    const sell = mkReport({ red: 2, cGold: true, cBear: true, bottomReversal: true, grade: 'prime', catchSell: true });
    expect(ids(sell)).not.toContain('reversal');
    // 非底部反彈 → 否決
    const noBottom = mkReport({ red: 2, cGold: true, bottomReversal: false, grade: 'prime' });
    expect(ids(noBottom)).not.toContain('reversal');
  });
});
