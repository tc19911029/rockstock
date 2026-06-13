/**
 * 「模式 × 情緒階段」交叉勝率表 + tier/source 聚合（純函式，P2）
 *
 * 注意：
 *   - winRate 只算 baseline filled 且該 horizon 非 null 的事件
 *   - unfillable（no_fill 一字板買不進）單獨列 — 打板模式下「買不到率」本身是訊號
 *   - n < LOW_SAMPLE_N 的 cell 標 lowSample，前端灰顯（仿 TeacherLeaderboard 慣例）
 *   - tier C 的 win 語意是「跌」（避開名單驗證）— 聚合時不反轉數字，
 *     由讀表者按 tier 自行解讀（表格如實呈現報酬）
 */

import type { CnRecoMode, CnTier, EmotionStage, CnAgentSource } from '../types';
import { STAGE_LABELS } from '../types';
import type { CnRecoEventWithReturns } from './recoPipeline';
import { isShortTermSuccess } from '../successCriterion';

export const LOW_SAMPLE_N = 10;

// 2026-06-13 口徑統一：推薦後第 1,2,3,4,5,10,20 個交易日
const WIN_HORIZONS = ['d1', 'd2', 'd3', 'd4', 'd5'] as const;
const AVG_HORIZONS = ['d1', 'd2', 'd3', 'd4', 'd5', 'd10', 'd20'] as const;
type WinHorizon = (typeof WIN_HORIZONS)[number];
type AvgHorizon = (typeof AVG_HORIZONS)[number];

export interface CellStats {
  n: number;
  filled: number;
  unfillable: number;
  noData: number;
  pending: number;
  winRate: Record<WinHorizon, number | null>;
  avg: Record<AvgHorizon, number | null>;
  /** d5 對上證超額平均 */
  excessAvg: number | null;
  /** 成功率 = d5 收盤 >+3% 的比例（已走完 d5 的事件中） */
  successRate: number | null;
  lowSample: boolean;
}

export interface CrossCell extends CellStats {
  mode: CnRecoMode;
  phase: EmotionStage;
}

export interface TierCell extends CellStats {
  tier: CnTier;
}

export interface SourceCell extends CellStats {
  agentSource: CnAgentSource;
}

const round2 = (x: number): number => +x.toFixed(2);

function aggregate(events: CnRecoEventWithReturns[]): CellStats {
  const filled = events.filter((e) => e.baseline?.status === 'filled');
  const winRate = {} as Record<WinHorizon, number | null>;
  for (const h of WIN_HORIZONS) {
    const vals = filled.map((e) => e.returns?.[h]).filter((v): v is number => v !== null && v !== undefined);
    winRate[h] = vals.length > 0 ? round2(vals.filter((v) => v > 0).length / vals.length) : null;
  }
  const avg = {} as Record<AvgHorizon, number | null>;
  for (const h of AVG_HORIZONS) {
    const vals = filled.map((e) => e.returns?.[h]).filter((v): v is number => v !== null && v !== undefined);
    avg[h] = vals.length > 0 ? round2(vals.reduce((a, b) => a + b, 0) / vals.length) : null;
  }
  const excessVals = filled
    .map((e) => e.returns?.excess?.d5)
    .filter((v): v is number => v !== null && v !== undefined);
  // 成功率：d5 已走完的事件中 d5>+3% 的比例
  const succJudged = filled.map((e) => isShortTermSuccess(e.returns)).filter((v): v is boolean => v !== null);
  return {
    n: events.length,
    filled: filled.length,
    unfillable: events.filter((e) => e.baseline?.status === 'no_fill').length,
    noData: events.filter((e) => e.baseline?.status === 'no_data').length,
    pending: events.filter((e) => !e.baseline || e.baseline.status === 'pending').length,
    winRate,
    avg,
    excessAvg: excessVals.length > 0 ? round2(excessVals.reduce((a, b) => a + b, 0) / excessVals.length) : null,
    successRate: succJudged.length > 0 ? round2(succJudged.filter(Boolean).length / succJudged.length) : null,
    lowSample: filled.length < LOW_SAMPLE_N,
  };
}

function groupBy<K extends string>(
  events: CnRecoEventWithReturns[],
  keyOf: (e: CnRecoEventWithReturns) => K,
): Map<K, CnRecoEventWithReturns[]> {
  const m = new Map<K, CnRecoEventWithReturns[]>();
  for (const e of events) {
    const k = keyOf(e);
    const arr = m.get(k) ?? [];
    arr.push(e);
    m.set(k, arr);
  }
  return m;
}

/** 模式 × 情緒階段（只取 tier A/B — C 是避開名單，混進來會污染操作統計） */
export function buildModePhaseCrossTable(events: CnRecoEventWithReturns[]): CrossCell[] {
  const ab = events.filter((e) => e.tier !== 'C');
  const out: CrossCell[] = [];
  for (const [key, group] of groupBy(ab, (e) => `${e.mode}|${e.sentimentPhase}` as const)) {
    const [mode, phase] = key.split('|') as [CnRecoMode, EmotionStage];
    out.push({ mode, phase, ...aggregate(group) });
  }
  return out.sort((a, b) => b.n - a.n);
}

export function buildTierTable(events: CnRecoEventWithReturns[]): TierCell[] {
  return [...groupBy(events, (e) => e.tier)].map(([tier, group]) => ({ tier, ...aggregate(group) }))
    .sort((a, b) => a.tier.localeCompare(b.tier));
}

export function buildSourceTable(events: CnRecoEventWithReturns[]): SourceCell[] {
  return [...groupBy(events, (e) => e.agentSource)].map(([agentSource, group]) => ({ agentSource, ...aggregate(group) }))
    .sort((a, b) => a.agentSource.localeCompare(b.agentSource));
}

export interface StageCell extends CellStats {
  phase: EmotionStage;
  phaseLabel: string;
}

/**
 * 情緒階段勝率表（使用者指定格式）：各階段推薦次數 + 第1..20日勝率 + 平均漲幅 + 成功率。
 * 只取 tier A/B（C 是避開名單）。八階段固定順序排，沒資料的階段也列（n=0）讓表完整。
 */
const STAGE_ORDER: EmotionStage[] = ['frozen', 'repair', 'launch', 'main_rise', 'climax', 'divergence', 'retreat', 'crash'];

export function buildStageTable(events: CnRecoEventWithReturns[]): StageCell[] {
  const ab = events.filter((e) => e.tier !== 'C');
  const byPhase = groupBy(ab, (e) => e.sentimentPhase);
  return STAGE_ORDER.map((phase) => ({
    phase,
    phaseLabel: STAGE_LABELS[phase],
    ...aggregate(byPhase.get(phase) ?? []),
  }));
}
