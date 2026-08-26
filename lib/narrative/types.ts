import type { TrendPosition, TrendState } from '@/lib/analysis/trendAnalysis';
import type { SignalSubtype } from '@/lib/rules/signalClassifier';
import type { SignalEvaluationPhase } from '@/lib/portfolio/signalEvaluationPhase';
import type { CandleWithIndicators, RuleSignal } from '@/types';

export type NarrativeEventCategory = 'risk' | 'exit' | 'entry' | 'kline' | 'trend' | 'watch';
export type NarrativeEventState = 'forming' | 'confirmed';
export type NarrativeDirection = 'bullish' | 'bearish' | 'neutral';
export type NarrativeAction = 'exit' | 'reduce' | 'evaluate-entry' | 'hold' | 'wait' | 'avoid-entry';
export type NarrativeTone = 'bullish' | 'bearish' | 'warning' | 'neutral';
export type NarrativeEvidenceLevel = 'high' | 'medium' | 'low';
export type NarrativeEvidenceDisposition = 'adopted' | 'conflicting' | 'background';

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

/**
 * 同一根／同一方向 K 棒可能同時命中多個命名規則；群組用來避免把高度同源的
 * 訊號誤算成多份獨立證據。eventLabels 仍保留可追溯性，但決策強度以群組計算。
 */
export interface NarrativeEvidenceGroup {
  readonly key: string;
  readonly disposition: NarrativeEvidenceDisposition;
  readonly category: NarrativeEventCategory;
  readonly direction: NarrativeDirection;
  readonly label: string;
  readonly eventCount: number;
  readonly eventLabels: readonly string[];
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
  readonly evidenceGroups: readonly NarrativeEvidenceGroup[];
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
  /** 盤中日 K 尚未定稿；規則會隨即時報價反覆成立／解除。 */
  readonly evaluationPhase?: SignalEvaluationPhase;
  /** 持股正式引擎的單一結論；有值時主卡動作不得被掃描規則覆寫。 */
  readonly holdingDecision?: {
    readonly action: 'exit' | 'reduce' | 'watch' | 'hold' | 'strategy_required';
    readonly label: string;
    readonly detail: string;
  };
}
