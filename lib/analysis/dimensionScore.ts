/**
 * 基本面 / 估值 維度評分（輕量）— 給基本面 tab 的評分摘要用
 *
 * 定位：個股「品質」判讀，非選股訊號（不接掃描鏈路，不違反鐵則 #5/#10）。
 * 重用 lib/agents/scoring 的 derivePEG / scoreToLight，估值區間用 lib/valuation/industryTemplate。
 */

import { derivePEG, scoreToLight } from '@/lib/agents/scoring';
import type { ScoreLight } from '@/lib/agents/scoringTypes';

export interface DimScore {
  /** 0-100；null = 資料不足 */
  score: number | null;
  light: ScoreLight;
  note: string;
}

export interface ValuationScore extends DimScore {
  /** 估值定位 */
  label: '偏低' | '合理' | '偏貴' | null;
}

// ── helpers ───────────────────────────────────────────────────────────────

/** 成長率（%）→ 0-100 */
function growthScore(pct: number): number {
  if (pct >= 30) return 92;
  if (pct >= 15) return 80;
  if (pct >= 5) return 66;
  if (pct >= 0) return 55;
  if (pct >= -10) return 38;
  return 22;
}

/** ROE（%）→ 0-100（與 scoring.deriveROE 分級一致）*/
function roeScore(pct: number): number {
  if (pct >= 20) return 100;
  if (pct >= 15) return 85;
  if (pct >= 10) return 65;
  if (pct >= 5) return 50;
  if (pct >= 0) return 35;
  return 15;
}

// ── 基本面 ─────────────────────────────────────────────────────────────────

export interface FundamentalInput {
  revenueYoY: number | null;
  epsYoY: number | null;
  grossMargin: number | null;
  netMargin: number | null;
  per: number | null;
  roePct: number | null;
}

/** 基本面評分 — 各可得指標 0-100 平均 */
export function scoreFundamental(f: FundamentalInput): DimScore {
  const parts: number[] = [];
  const bits: string[] = [];

  if (f.revenueYoY != null) {
    parts.push(growthScore(f.revenueYoY));
    bits.push(`營收YoY ${f.revenueYoY >= 0 ? '+' : ''}${f.revenueYoY.toFixed(0)}%`);
  }
  if (f.epsYoY != null) {
    parts.push(growthScore(f.epsYoY));
    bits.push(`EPS ${f.epsYoY >= 0 ? '+' : ''}${f.epsYoY.toFixed(0)}%`);
  }
  if (f.grossMargin != null) {
    const gm = f.grossMargin;
    parts.push(gm >= 40 ? 85 : gm >= 25 ? 68 : gm >= 15 ? 55 : gm >= 5 ? 42 : 30);
    bits.push(`毛利 ${gm.toFixed(0)}%`);
  }
  if (f.netMargin != null) {
    const nm = f.netMargin;
    parts.push(nm >= 20 ? 85 : nm >= 10 ? 68 : nm >= 5 ? 55 : nm >= 0 ? 42 : 25);
  }
  if (f.roePct != null) parts.push(roeScore(f.roePct));
  const peg = derivePEG(f.per, f.epsYoY);
  if (peg.score != null) parts.push(peg.score);

  if (parts.length === 0) return { score: null, light: 'yellow', note: '基本面資料不足' };
  const score = Math.round(parts.reduce((a, b) => a + b, 0) / parts.length);
  return { score, light: scoreToLight(score), note: bits.join('、') || '基本面' };
}

// ── 估值 ─────────────────────────────────────────────────────────────────

export interface ValuationInput {
  /** 估值 skill 深度結論（優先）*/
  conclusion: 'undervalued' | 'fair' | 'overvalued' | null;
  /** base（中性）情境距現價 fraction（已用即時價重算）*/
  baseUpside: number | null;
  /** 現價本益比 */
  per: number | null;
  /** 產業合理 PE（industryTemplate base）*/
  reasonablePeBase: number | null;
}

/** 估值評分 + 偏貴/合理/偏低定位 */
export function scoreValuation(v: ValuationInput): ValuationScore {
  let score: number | null = null;
  let label: ValuationScore['label'] = null;
  let note = '';

  if (v.conclusion) {
    score = v.conclusion === 'undervalued' ? 85 : v.conclusion === 'overvalued' ? 30 : 60;
    label = v.conclusion === 'undervalued' ? '偏低' : v.conclusion === 'overvalued' ? '偏貴' : '合理';
    note = `估值${label}（深度分析）`;
  } else if (v.baseUpside != null) {
    const up = v.baseUpside;
    if (up >= 0.3) { score = 88; label = '偏低'; note = `中性合理價較現價 +${(up * 100).toFixed(0)}%`; }
    else if (up >= 0.1) { score = 72; label = '偏低'; note = `中性合理價較現價 +${(up * 100).toFixed(0)}%`; }
    else if (up >= -0.05) { score = 55; label = '合理'; note = '接近中性合理價'; }
    else if (up >= -0.2) { score = 38; label = '偏貴'; note = `高於中性合理價 ${(-up * 100).toFixed(0)}%`; }
    else { score = 22; label = '偏貴'; note = `明顯高於中性合理價 ${(-up * 100).toFixed(0)}%`; }
  } else if (v.per != null && v.reasonablePeBase != null && v.reasonablePeBase > 0) {
    const ratio = v.per / v.reasonablePeBase;
    if (ratio <= 0.7) { score = 82; label = '偏低'; note = `PER ${v.per.toFixed(0)} 低於產業合理 ${v.reasonablePeBase}`; }
    else if (ratio <= 1.1) { score = 60; label = '合理'; note = `PER ${v.per.toFixed(0)} 接近產業合理 ${v.reasonablePeBase}`; }
    else if (ratio <= 1.4) { score = 40; label = '偏貴'; note = `PER ${v.per.toFixed(0)} 高於產業合理 ${v.reasonablePeBase}`; }
    else { score = 25; label = '偏貴'; note = `PER ${v.per.toFixed(0)} 遠高於產業合理 ${v.reasonablePeBase}`; }
  } else {
    return { score: null, light: 'yellow', note: '估值資料不足', label: null };
  }

  return { score, light: scoreToLight(score), note, label };
}

// ── 一句結論 ───────────────────────────────────────────────────────────────

export function fundamentalValuationConclusion(fund: DimScore, val: ValuationScore): string {
  const parts: string[] = [];
  if (val.label) parts.push(`估值${val.label}`);
  if (fund.score != null) {
    parts.push(`基本面${fund.score >= 60 ? '轉強' : fund.score < 45 ? '轉弱' : '持平'}`);
  }
  if (parts.length === 0) return '基本面 / 估值資料有限';
  return parts.join('、');
}
