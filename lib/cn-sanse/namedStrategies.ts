// ============================================================
// 三色「具名策略」— 單一事實來源（TW / CN 共用）。
//
// 把回測驗證過的幾種型態做成可選策略：判定全部衍生自既有 ConditionReport，
// 不另算指標、不改 combo grade 定義、不進書本選股鏈路（三色是自創因子，鐵則 #5）。
//
// 標籤一律「燈號＋白話」（🔴中線機構 / 🟣短線游資 / 🟡主力控盤 / 雙B金叉 / 捕撈金叉），
// 不出現 M1/M2/M5 這類回測代號。
//
// 既有名稱、收緊語意：
//   - 全共振⭐ = 紅紫黃三燈全亮＋雙B金叉＋捕撈金叉（不能只看 groupBuyCount）
//   - 底反🔥   = isReversalBuy()（conditions.ts；前端原本就有「底部反彈」level）
// 新增具名（前端單一 chip 無法表達，尤其「金叉或突破」是 OR）：
//   - 紅+黃+觸發 / 紅+雙B金叉 / 紅+雙B金叉或突破
// ============================================================

import { isFullResonance, isReversalBuy, type ConditionReport } from './conditions';

/** 具名策略 id（含沿用既有的底反）。 */
export type StrategyId = 'resonance' | 'red_yellow_trigger' | 'red_dualb_gold' | 'red_dualb_any' | 'reversal';
/** 三色掃描可選的「層級/策略」：後端三檔 level（嚴/中/寬）+ 具名策略 id。store/前端/工具列共用單一型別。 */
export type SanSeScanLevel = 'strict' | 'medium' | 'loose' | StrategyId;

export interface NamedStrategy {
  id: StrategyId;
  /** 畫面顯示標籤（燈號白話）。 */
  label: string;
  /** hover 說明。 */
  tip: string;
  /** 判定：給一筆三色條件報告 → 是否命中此策略（純衍生，不算指標）。 */
  match: (r: ConditionReport) => boolean;
}

const redOn = (r: ConditionReport): boolean => (r.combo?.redGate ?? r.scores.midStrength > 0);

/** 五個具名三色策略（順序＝畫面排列；應買順序由 buyScore 排，不靠此陣列）。 */
export const NAMED_STRATEGIES: NamedStrategy[] = [
  {
    id: 'resonance',
    label: '全共振⭐',
    tip: '🔴🟣🟡三燈全亮 ＋ 雙B金叉 ＋ 捕撈金叉同一天。這是嚴格全共振，不以三組任意買訊替代；樣本稀有，需連同樣本數判讀。',
    match: isFullResonance,
  },
  {
    id: 'red_yellow_trigger',
    label: '紅+黃+觸發',
    tip: '🔴紅(機構)＋🟡黃(控盤) 中線骨架 ＋ 一個觸發（雙B金叉/突破 或 捕撈金叉）。大樣本、最實用的中線進場。',
    match: (r) => r.scores.midStrength > 0 && r.scores.midControl > 0 && (r.doubleB.buyHit || r.catch.buyHit),
  },
  {
    id: 'red_dualb_gold',
    label: '紅+雙B金叉',
    tip: '🔴紅(機構)在場 ＋ 主圖黃線穿紅線（雙B黃紅金叉）。只認金叉、較乾淨；陸股這招最有效。',
    match: (r) => redOn(r) && r.doubleB.buy.some((c) => c.id === 'b_gold' && c.met),
  },
  {
    id: 'red_dualb_any',
    label: '紅+雙B金叉/突破',
    tip: '🔴紅(機構)在場 ＋（黃紅金叉 或 收盤突破智能交易線）。比「只金叉」多收一些、較雜。',
    match: (r) => redOn(r) && r.doubleB.buyHit,
  },
  {
    id: 'reversal',
    label: '底反🔥',
    tip: '🔴紅(機構)在場 ＋ 捕撈 0 軸下金叉（底部反彈）＋ 無賣訊。回測兩市場 OOS 勝率最高、最不易套（沿用既有底反）。',
    match: (r) => isReversalBuy(r),
  },
];

/** 給一筆報告 → 回傳命中的所有具名策略（卡片徽章/明細用）。 */
export function matchedStrategies(r: ConditionReport | undefined): NamedStrategy[] {
  if (!r) return [];
  return NAMED_STRATEGIES.filter((s) => s.match(r));
}

/** 依 id 取策略定義。 */
export function getStrategy(id: string | null | undefined): NamedStrategy | undefined {
  return id ? NAMED_STRATEGIES.find((s) => s.id === id) : undefined;
}
