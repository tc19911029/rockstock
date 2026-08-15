import type { TrendPosition, TrendState } from '@/lib/analysis/trendAnalysis';
import type { SignalSubtype } from '@/lib/rules/signalClassifier';
import type { CandleWithIndicators, RuleSignal } from '@/types';

export type NarrativeEventCategory = 'risk' | 'exit' | 'entry' | 'kline' | 'trend' | 'watch';
export type NarrativeEventState = 'forming' | 'confirmed';
export type NarrativeDirection = 'bullish' | 'bearish' | 'neutral';
export type NarrativeAction = 'exit' | 'reduce' | 'evaluate-entry' | 'hold' | 'wait' | 'avoid-entry';
export type NarrativeTone = 'bullish' | 'bearish' | 'warning' | 'neutral';
export type NarrativeEvidenceLevel = 'high' | 'medium' | 'low';

export interface NarrativeClassifiedSignal {
  readonly sig: RuleSignal;
  readonly subtype: SignalSubtype;
}

/**
 * 單一時間點的不可變事件。observedAtIndex/date 永遠是事件「當下」，不可事後回填。
 * setupKey 用於合併同源規則，sourceRuleIds 則保留可追溯性。
 */
export interface ChartNarrativeEvent {
  readonly id: string;
  readonly setupKey: string;
  readonly observedAtIndex: number;
  readonly observedAtDate: string;
  readonly category: NarrativeEventCategory;
  readonly state: NarrativeEventState;
  readonly direction: NarrativeDirection;
  readonly action: NarrativeAction;
  readonly label: string;
  readonly description: string;
  readonly sourceRuleIds: readonly string[];
  readonly sourceFamily: string;
  readonly confirmation?: string;
  readonly invalidation?: string;
  readonly bookRef?: string;
  readonly priority: number;
}

export interface ChartNarrative {
  readonly phase: string;
  readonly trendState: TrendState | '資料不足';
  readonly trendPosition: TrendPosition | '資料不足';
  readonly action: NarrativeAction;
  readonly actionLabel: string;
  readonly tone: NarrativeTone;
  readonly headline: string;
  readonly summary: string;
  readonly confirmation: string;
  readonly invalidation: string;
  readonly primaryEvent: ChartNarrativeEvent;
  readonly secondaryEvents: readonly ChartNarrativeEvent[];
  readonly events: readonly ChartNarrativeEvent[];
  readonly blockers: readonly string[];
  readonly evidenceLevel: NarrativeEvidenceLevel;
}

export interface BuildChartNarrativeInput {
  readonly candles: readonly CandleWithIndicators[];
  readonly currentIndex: number;
  readonly signals: readonly RuleSignal[];
  readonly classifiedSignals?: readonly NarrativeClassifiedSignal[];
  readonly hasPosition: boolean;
  readonly prohibitions?: readonly string[];
  /** 已確認的結構性硬風險，例如頂部型態跌破頸線。 */
  readonly hardRisks?: readonly string[];
  readonly operatingMA?: string | null;
}
