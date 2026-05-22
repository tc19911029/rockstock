/**
 * Multi-Agent 回測 schema
 *
 * 對每日 FinalDecision 接 ForwardAnalyzer 算 d1/d2/d3/d5/d10/d20 收益。
 * 不重算技術指標 — 純利用 d 天後的價格計算。
 *
 * 統計各 Agent verdict 對應 d5/d20 平均報酬與勝率，作為「Agent 命中率」基礎。
 */

import type { MarketId } from '@/lib/scanner/types';
import type {
  ChipAnswer,
  FinalAction,
  FundamentalAnswer,
  NewsAnswer,
  RiskAnswer,
  TechnicalAnswer,
} from '@/lib/agents/types';

export const BACKTEST_SCHEMA_VERSION = 1 as const;

export interface BacktestEntry {
  symbol: string;
  name: string;
  market: MarketId;

  /** 從 FinalDecision 取 */
  action: FinalAction;
  decisionPath: string;
  bullScore: number;
  bearScore: number;
  sizeHint: number;

  /** 4+1 個 agent verdict（並列，用於命中率統計）*/
  verdictsByAgent: {
    technical:   TechnicalAnswer['verdict'] | null;
    news:        NewsAnswer['verdict'] | null;
    chip:        ChipAnswer['verdict'] | null;
    fundamental: FundamentalAnswer['verdict'] | null;
    risk:        RiskAnswer['verdict'] | null;
  };

  /** 進場價（FinalDecision.entryPrice 或 candidateRow.price）*/
  entryPrice: number | null;
  /** 各 d 收益（從 ForwardAnalyzer StockForwardPerformance）*/
  d1Return:  number | null;
  d2Return:  number | null;
  d3Return:  number | null;
  d5Return:  number | null;
  d10Return: number | null;
  d20Return: number | null;
  /** 從 entryPrice 起算（不是 nextOpen）*/
  maxGain:   number | null;
  maxLoss:   number | null;

  /** 從 FinalDecision 取的目標/停損 — 算是否觸發 */
  stopLoss?: number | null;
  target1?: number | null;
  target2?: number | null;
  stopLossTriggered?: boolean;
  target1Triggered?: boolean;
  target2Triggered?: boolean;
}

export interface BacktestReport {
  schemaVersion: typeof BACKTEST_SCHEMA_VERSION;
  date: string;                // 決策日
  market: MarketId;
  generatedAt: string;
  /** 截至此日期之前的 d* 才有資料（其他為 null）*/
  computedThrough: string | null;
  entries: BacktestEntry[];
}

/** Agent verdict → 平均收益 + 勝率（用 d5 / d20 為主）*/
export interface AgentAccuracyStats {
  agent: 'technical' | 'news' | 'chip' | 'fundamental' | 'risk';
  /** key 是 verdict 字串（pass/watch/fail 或 green/yellow/red）*/
  byVerdict: Record<string, {
    sampleSize: number;
    avgD1Return:  number | null;
    avgD5Return:  number | null;
    avgD20Return: number | null;
    /** d5 > 0 比例 */
    winRateD5:  number | null;
    winRateD20: number | null;
  }>;
}

export interface BacktestSummary {
  schemaVersion: typeof BACKTEST_SCHEMA_VERSION;
  from: string;
  to: string;
  totalDecisions: number;
  byAction: Record<FinalAction, {
    sampleSize: number;
    avgD1Return:  number | null;
    avgD5Return:  number | null;
    avgD20Return: number | null;
    winRateD5:  number | null;
    winRateD20: number | null;
  }>;
  agentAccuracy: AgentAccuracyStats[];
}
