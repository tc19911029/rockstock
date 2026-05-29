/**
 * 基本面補漲策略 — 100 分制評分核心（2026-05-27）
 *
 * 4 維 × 25 分 = 100：
 *   A. 月營收成長 (TW) / 季報成長 (CN)   - 25
 *   B. 獲利改善 (TW) / 扣非獲利品質 (CN)  - 25
 *   C. 估值吸引力                         - 25
 *   D. 風險控制（扣分為主）               - 25
 *
 * 設計原則：
 *   - 每個維度從 0 開始累加加分項，再扣減扣分項，最後 clamp [0, 25]
 *   - score 加減項全部記錄成 ScoreItem，供 UI 顯示明細與 contract test 驗證
 *   - 缺資料 = 不加不減（中性），不懲罰小型股 / 新上市公司
 *   - 風險旗（RiskFlag）由 pipeline 端先偵測好填進 bundle，scoring 只負責換算成 ScoreItem
 */

import type {
  ScoreBreakdown,
  ScoreItem,
  DimensionScore,
  RecommendationGrade,
  StrategyFlag,
  TwFundamentalBundle,
  CnFundamentalBundle,
} from './types';

const DIM_CAP = 25;
const TOTAL_CAP = 100;

// ────────────────────────────────────────────────────────────────────────────
// 共用 helper
// ────────────────────────────────────────────────────────────────────────────

function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n));
}

function sumDelta(items: ScoreItem[]): number {
  return items.reduce((s, it) => s + it.delta, 0);
}

function buildDim(
  dimension: DimensionScore['dimension'],
  label: string,
  items: ScoreItem[],
): DimensionScore {
  return {
    dimension,
    label,
    cap: DIM_CAP,
    items,
    score: clamp(sumDelta(items), 0, DIM_CAP),
  };
}

// ────────────────────────────────────────────────────────────────────────────
// TW 評分（month-revenue-led）
// ────────────────────────────────────────────────────────────────────────────

/** A. 月營收成長（25 分） */
export function scoreTwGrowth(b: TwFundamentalBundle): DimensionScore {
  const items: ScoreItem[] = [];

  // 加分
  const yoy = b.latestMonthRevenueYoY;
  if (yoy != null) {
    if (yoy > 50) items.push({ key: 'rev_yoy_50plus', delta: 8, reason: `最新月營收 YoY +${yoy.toFixed(1)}%` });
    else if (yoy > 20) items.push({ key: 'rev_yoy_20plus', delta: 5, reason: `最新月營收 YoY +${yoy.toFixed(1)}%` });
    else if (yoy < 0) items.push({ key: 'rev_yoy_negative', delta: -5, reason: `最新月營收 YoY ${yoy.toFixed(1)}%` });
  }

  const mom = b.latestMonthRevenueMoM;
  if (mom != null) {
    if (mom > 10) items.push({ key: 'rev_mom_10plus', delta: 3, reason: `MoM +${mom.toFixed(1)}%` });
    else if (mom < -10) items.push({ key: 'rev_mom_negative', delta: -3, reason: `MoM ${mom.toFixed(1)}%` });
  }

  const cumYoy = b.cumulativeRevenueYoY;
  if (cumYoy != null) {
    if (cumYoy > 20) items.push({ key: 'cum_rev_yoy_20plus', delta: 5, reason: `累計營收 YoY +${cumYoy.toFixed(1)}%` });
    else if (cumYoy > 10) items.push({ key: 'cum_rev_yoy_10plus', delta: 3, reason: `累計營收 YoY +${cumYoy.toFixed(1)}%` });
  }

  // 連 3 月成長
  if (b.consecutiveGrowthMonths >= 3) {
    items.push({ key: 'consecutive_3m_growth', delta: 4, reason: `連 ${b.consecutiveGrowthMonths} 月 YoY 成長` });
  } else if (b.consecutiveGrowthMonths <= -3) {
    items.push({ key: 'consecutive_3m_decline', delta: -5, reason: `連 ${Math.abs(b.consecutiveGrowthMonths)} 月營收下滑` });
  }

  // 創新高
  if (b.isAllTimeHigh) items.push({ key: 'all_time_high', delta: 5, reason: '最新月營收創歷史新高' });
  else if (b.isLatest12mHigh) items.push({ key: 'high_12m', delta: 3, reason: '最新月營收創 12 月新高' });

  // 單月暴增但累計沒成長
  if (yoy != null && yoy > 50 && cumYoy != null && cumYoy < 10) {
    items.push({ key: 'single_month_spike', delta: -3, reason: '單月暴增但累計營收沒成長' });
  }

  return buildDim('growth', '月營收成長', items);
}

/** B. 獲利改善（25 分） */
export function scoreTwProfitability(b: TwFundamentalBundle): DimensionScore {
  const items: ScoreItem[] = [];

  const epsYoY = b.latestQuarterEpsYoY;
  if (epsYoY != null) {
    if (epsYoY > 0) items.push({ key: 'eps_yoy_growth', delta: 5, reason: `EPS YoY +${epsYoY.toFixed(1)}%` });
    else items.push({ key: 'eps_yoy_decline', delta: -5, reason: `EPS YoY ${epsYoY.toFixed(1)}%` });
  }

  const epsQoQ = b.latestQuarterEpsQoQ;
  if (epsQoQ != null && epsQoQ > 0) {
    items.push({ key: 'eps_qoq_growth', delta: 4, reason: `EPS QoQ +${epsQoQ.toFixed(1)}%` });
  }

  // 毛利率比較（用 quarters 序列）
  if (b.quarters.length >= 2) {
    const cur = b.quarters[0];
    const prev = b.quarters[1];
    if (cur.grossProfit != null && prev.grossProfit != null && cur.revenue > 0 && prev.revenue > 0) {
      const gmCur = cur.grossProfit / cur.revenue;
      const gmPrev = prev.grossProfit / prev.revenue;
      const diff = (gmCur - gmPrev) * 100;
      if (diff > 0) items.push({ key: 'gross_margin_qoq_up', delta: 4, reason: `毛利率 QoQ +${diff.toFixed(1)}pp` });
      else if (diff < -3) items.push({ key: 'gross_margin_qoq_down_3pp', delta: -4, reason: `毛利率 QoQ ${diff.toFixed(1)}pp` });
    }
    if (cur.netMargin != null && prev.netMargin != null) {
      const diff = (cur.netMargin - prev.netMargin) * 100;
      if (diff > 0) items.push({ key: 'net_margin_qoq_up', delta: 4, reason: `淨利率 QoQ +${diff.toFixed(1)}pp` });
      else if (diff < -3) items.push({ key: 'net_margin_qoq_down_3pp', delta: -5, reason: `淨利率 QoQ ${diff.toFixed(1)}pp` });
    }
  }

  // ROE
  if (b.latestRoe != null && b.latestRoe > 15) {
    items.push({ key: 'roe_high', delta: 4, reason: `ROE ${b.latestRoe.toFixed(1)}%` });
  }

  // 營收成長但 EPS 沒成長 / 毛利率下滑
  if (b.latestMonthRevenueYoY != null && b.latestMonthRevenueYoY > 20 && epsYoY != null && epsYoY < 5) {
    items.push({ key: 'rev_grow_eps_stuck', delta: -5, reason: '營收成長但 EPS 沒成長' });
  }

  return buildDim('profitability', '獲利改善', items);
}

// ────────────────────────────────────────────────────────────────────────────
// CN 評分（season-report-led + deducted-net-income）
// ────────────────────────────────────────────────────────────────────────────

/** A. 季報成長（25 分） */
export function scoreCnGrowth(b: CnFundamentalBundle): DimensionScore {
  const items: ScoreItem[] = [];

  const revYoy = b.latestQuarterRevenueYoY;
  if (revYoy != null) {
    if (revYoy > 50) items.push({ key: 'q_rev_yoy_50plus', delta: 8, reason: `季營收 YoY +${revYoy.toFixed(1)}%` });
    else if (revYoy > 20) items.push({ key: 'q_rev_yoy_20plus', delta: 5, reason: `季營收 YoY +${revYoy.toFixed(1)}%` });
    else if (revYoy < 0) items.push({ key: 'q_rev_yoy_negative', delta: -5, reason: `季營收 YoY ${revYoy.toFixed(1)}%` });
  }

  const profitYoy = b.latestQuarterNetProfitParentYoY;
  if (profitYoy != null) {
    if (profitYoy > 100) items.push({ key: 'net_profit_yoy_100plus', delta: 8, reason: `歸母淨利 YoY +${profitYoy.toFixed(1)}%` });
    else if (profitYoy > 30) items.push({ key: 'net_profit_yoy_30plus', delta: 5, reason: `歸母淨利 YoY +${profitYoy.toFixed(1)}%` });
    else if (profitYoy < 0) items.push({ key: 'net_profit_yoy_negative', delta: -5, reason: `歸母淨利 YoY ${profitYoy.toFixed(1)}%` });
  }

  // EPS YoY（粗估：latestQuarterEps × 4 vs 前年同期 — 受限資料源這裡先省略，由 deductedNetProfit 旗補強）

  if (b.roe != null && b.roe > 15) items.push({ key: 'roe_high', delta: 4, reason: `ROE ${b.roe.toFixed(1)}%` });

  return buildDim('growth', '季報成長', items);
}

/** B. 扣非獲利品質（25 分）— CN 專用 */
export function scoreCnProfitability(b: CnFundamentalBundle): DimensionScore {
  const items: ScoreItem[] = [];

  const dedYoy = b.latestQuarterDeductedNetProfitYoY;
  if (dedYoy != null) {
    if (dedYoy > 50) items.push({ key: 'ded_net_yoy_50plus', delta: 8, reason: `扣非淨利 YoY +${dedYoy.toFixed(1)}%` });
    else if (dedYoy > 30) items.push({ key: 'ded_net_yoy_30plus', delta: 5, reason: `扣非淨利 YoY +${dedYoy.toFixed(1)}%` });
  }

  const ratio = b.deductedNetProfitRatio;
  if (ratio != null) {
    if (ratio > 0.9) items.push({ key: 'ded_ratio_90plus', delta: 8, reason: `扣非/歸母 ${(ratio * 100).toFixed(1)}%` });
    else if (ratio > 0.7) items.push({ key: 'ded_ratio_70plus', delta: 5, reason: `扣非/歸母 ${(ratio * 100).toFixed(1)}%` });
    else if (ratio < 0.5) items.push({ key: 'ded_ratio_below_50', delta: -8, reason: `扣非/歸母 ${(ratio * 100).toFixed(1)}%（非經常性收益占比過高）` });
  }

  if (b.operatingCashFlow != null && b.latestQuarterNetProfitParent != null && b.operatingCashFlow > 0 && b.latestQuarterNetProfitParent > 0) {
    items.push({ key: 'cash_flow_positive', delta: 4, reason: '經營現金流為正' });
  } else if (b.operatingCashFlow != null && b.operatingCashFlow < 0) {
    items.push({ key: 'cash_flow_negative', delta: -5, reason: '經營現金流為負' });
  }

  return buildDim('profitability', '扣非獲利品質', items);
}

// ────────────────────────────────────────────────────────────────────────────
// C. 估值吸引力（25 分）— TW/CN 共用骨架
// ────────────────────────────────────────────────────────────────────────────

export interface ValuationInputs {
  forwardPeBase: number | null;
  fairPeBase: number;
  baseUpside: number | null;   // (baseFairPrice / currentPrice) - 1
  optimisticOnly: boolean;     // 只有樂觀情境才有空間
  pbRatio: number | null;
  ttmPe: number | null;
}

export function scoreValuation(inp: ValuationInputs): DimensionScore {
  const items: ScoreItem[] = [];

  if (inp.forwardPeBase != null && inp.forwardPeBase > 0) {
    if (inp.forwardPeBase < inp.fairPeBase * 0.8) {
      items.push({ key: 'fwd_pe_below_80pct_fair', delta: 8, reason: `Forward PE ${inp.forwardPeBase.toFixed(1)} < 合理 PE ${inp.fairPeBase} × 80%` });
    } else if (inp.forwardPeBase < inp.fairPeBase) {
      items.push({ key: 'fwd_pe_below_fair', delta: 5, reason: `Forward PE ${inp.forwardPeBase.toFixed(1)} < 合理 PE ${inp.fairPeBase}` });
    }
  }

  if (inp.baseUpside != null) {
    if (inp.baseUpside >= 0.4) items.push({ key: 'upside_40plus', delta: 8, reason: `中性合理價高於現價 ${(inp.baseUpside * 100).toFixed(1)}%` });
    else if (inp.baseUpside >= 0.2) items.push({ key: 'upside_20plus', delta: 5, reason: `中性合理價高於現價 ${(inp.baseUpside * 100).toFixed(1)}%` });
    else if (inp.baseUpside < 0) items.push({ key: 'price_above_fair', delta: -6, reason: '現價已超過中性合理價' });
  }

  if (inp.pbRatio != null) {
    if (inp.pbRatio < 1.5) items.push({ key: 'pb_undervalued', delta: 3, reason: `PB ${inp.pbRatio.toFixed(2)}` });
    else if (inp.pbRatio > 5) items.push({ key: 'pb_overheated', delta: -4, reason: `PB ${inp.pbRatio.toFixed(2)} 過高` });
  }

  // TTM PE 與 Forward PE 都明顯高於產業合理值
  if (inp.ttmPe != null && inp.ttmPe > inp.fairPeBase * 1.5 && inp.forwardPeBase != null && inp.forwardPeBase > inp.fairPeBase * 1.5) {
    items.push({ key: 'both_pe_above_fair_50pct', delta: -5, reason: 'TTM PE 與 Forward PE 都明顯高於產業合理值' });
  }

  if (inp.optimisticOnly) {
    items.push({ key: 'only_optimistic_has_upside', delta: -5, reason: '只有樂觀情境才有空間' });
  }

  return buildDim('valuation', '估值吸引力', items);
}

// ────────────────────────────────────────────────────────────────────────────
// D. 風險控制（25 分，扣分為主）— TW/CN 各自有不同因子
// ────────────────────────────────────────────────────────────────────────────

export interface RiskInputs {
  hasOneTimeGain: boolean;
  oneTimeGainImpactPct?: number | null;     // 一次性收益佔 EPS %
  cyclicalPeak: boolean;
  pbOverheated: boolean;
  dilutionPending: boolean;
  customerConcentration?: boolean;          // CN 不必填
  inventoryYoyAbnormal?: boolean;
  receivableYoyAbnormal?: boolean;
  cashFlowDeteriorating?: boolean;
  policyOverPerformance?: boolean;
  stockHasRunUp?: boolean;
}

export function scoreRisk(inp: RiskInputs): DimensionScore {
  const items: ScoreItem[] = [];

  // 風控採「滿分起跳、扣分」策略：起始 25
  items.push({ key: 'risk_base', delta: 25, reason: '風控基底' });

  if (inp.hasOneTimeGain) {
    if (inp.oneTimeGainImpactPct != null && inp.oneTimeGainImpactPct > 30) {
      items.push({ key: 'one_time_gain_dominant', delta: -10, reason: `一次性收益佔 EPS ${inp.oneTimeGainImpactPct.toFixed(1)}%` });
    } else {
      items.push({ key: 'one_time_gain_minor', delta: -5, reason: '有一次性收益（佔比可控）' });
    }
  }

  if (inp.cyclicalPeak) items.push({ key: 'cyclical_peak', delta: -8, reason: '景氣循環處於高峰（PB 高 + ROE 高 + 產業位階高）' });
  if (inp.pbOverheated) items.push({ key: 'pb_overheated', delta: -5, reason: 'PB 過高' });
  if (inp.dilutionPending) items.push({ key: 'dilution_pending', delta: -5, reason: '有待生效的增資/CB/GDR' });
  if (inp.customerConcentration) items.push({ key: 'customer_concentration', delta: -5, reason: '客戶過度集中' });
  if (inp.inventoryYoyAbnormal) items.push({ key: 'inventory_yoy_abnormal', delta: -5, reason: '存貨大幅增加' });
  if (inp.receivableYoyAbnormal) items.push({ key: 'receivable_yoy_abnormal', delta: -5, reason: '應收帳款異常增加' });
  if (inp.cashFlowDeteriorating) items.push({ key: 'cash_flow_deteriorating', delta: -5, reason: '經營現金流惡化' });
  if (inp.policyOverPerformance) items.push({ key: 'policy_over_performance', delta: -5, reason: '政策題材大於業績' });
  if (inp.stockHasRunUp) items.push({ key: 'stock_run_up', delta: -5, reason: '股價已大漲且創高' });

  return buildDim('risk', '風險控制', items);
}

// ────────────────────────────────────────────────────────────────────────────
// 總分 + grade + flag
// ────────────────────────────────────────────────────────────────────────────

export function gradeFromTotal(total: number): RecommendationGrade {
  if (total >= 85) return 'A_core';
  if (total >= 75) return 'B_candidate';
  if (total >= 65) return 'C_watch';
  if (total >= 55) return 'D_weak';
  return 'excluded';
}

export interface BuildBreakdownInput {
  growth: DimensionScore;
  profitability: DimensionScore;
  valuation: DimensionScore;
  risk: DimensionScore;
  flags: StrategyFlag[];
}

export function buildBreakdown(inp: BuildBreakdownInput): ScoreBreakdown {
  const total = clamp(inp.growth.score + inp.profitability.score + inp.valuation.score + inp.risk.score, 0, TOTAL_CAP);
  let grade = gradeFromTotal(total);

  // 防呆規則 #11：只有樂觀情境才有空間 → grade 不可 A
  if (inp.flags.includes('only_optimistic_has_upside') && grade === 'A_core') {
    grade = 'B_candidate';
  }
  // 防呆規則 #1+#2：一次性收益旗 → 不可標 undervalued + 不可進 A 級
  if (inp.flags.includes('one_time_gain') && grade === 'A_core') {
    grade = 'B_candidate';
  }

  return {
    growth: inp.growth,
    profitability: inp.profitability,
    valuation: inp.valuation,
    risk: inp.risk,
    total,
    grade,
    flags: inp.flags,
  };
}
