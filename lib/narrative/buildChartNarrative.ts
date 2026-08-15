import { detectTrend, detectTrendPosition } from '@/lib/analysis/trendAnalysis';
import {
  analyzeKLineSignals,
  isKLineSignal,
  type KLineSignalAnalysis,
} from '@/lib/rules/klineSignalAnalysis';
import { classifySignal, type SignalSubtype } from '@/lib/rules/signalClassifier';
import { pickHoldingRiskProhibitions } from '@/lib/rules/prohibitionRelevance';
import type { RuleSignal } from '@/types';
import type {
  BuildChartNarrativeInput,
  ChartNarrative,
  ChartNarrativeEvent,
  NarrativeAction,
  NarrativeClassifiedSignal,
  NarrativeDirection,
  NarrativeTone,
} from './types';

const ACTION_LABEL: Record<NarrativeAction, string> = {
  exit: '優先出場',
  reduce: '保護部位',
  'evaluate-entry': '評估進場',
  hold: '續抱觀察',
  wait: '等待確認',
  'avoid-entry': '暫不進場',
};

function compact(value: string, maxLength = 150): string {
  const normalized = value.replace(/\s+/g, ' ').trim();
  return normalized.length > maxLength ? `${normalized.slice(0, maxLength - 1)}…` : normalized;
}

function freezeEvent(event: ChartNarrativeEvent): ChartNarrativeEvent {
  return Object.freeze({
    ...event,
    sourceRuleIds: Object.freeze([...event.sourceRuleIds]),
  });
}

function directionForSubtype(subtype: SignalSubtype): NarrativeDirection {
  if (subtype === 'entry_strong' || subtype === 'entry_soft' || subtype === 'trend') return 'bullish';
  if (subtype === 'exit_strong' || subtype === 'exit_soft') return 'bearish';
  return 'neutral';
}

function actionForSubtype(subtype: SignalSubtype): NarrativeAction {
  if (subtype === 'exit_strong') return 'exit';
  if (subtype === 'exit_soft') return 'reduce';
  if (subtype === 'entry_strong') return 'evaluate-entry';
  return 'wait';
}

function priorityForSubtype(subtype: SignalSubtype, state: 'forming' | 'confirmed'): number {
  if (state === 'forming') return 48;
  switch (subtype) {
    case 'exit_strong': return 100;
    case 'exit_soft': return 78;
    case 'entry_strong': return 70;
    case 'entry_soft': return 55;
    case 'warn': return 45;
    case 'trend': return 30;
  }
}

function eventForKLine(
  analysis: KLineSignalAnalysis,
  subtype: SignalSubtype,
  index: number,
  date: string,
): ChartNarrativeEvent {
  const state = analysis.state;
  return freezeEvent({
    id: `${date}:kline:${analysis.signal.ruleId}`,
    setupKey: `kline:${analysis.signal.ruleId}`,
    observedAtIndex: index,
    observedAtDate: date,
    category: 'kline',
    state,
    direction: analysis.direction,
    action: state === 'forming' ? 'wait' : actionForSubtype(subtype),
    label: analysis.signal.label,
    description: compact(analysis.interpretation),
    sourceRuleIds: [analysis.signal.ruleId],
    sourceFamily: `K線：${analysis.family}`,
    confirmation: analysis.confirmation,
    invalidation: analysis.invalidation,
    bookRef: analysis.bookRef,
    priority: priorityForSubtype(subtype, state),
  });
}

function eventForSignal(
  signal: RuleSignal,
  subtype: SignalSubtype,
  index: number,
  date: string,
): ChartNarrativeEvent {
  const category = subtype.startsWith('exit')
    ? 'exit'
    : subtype.startsWith('entry')
      ? 'entry'
      : subtype === 'trend'
        ? 'trend'
        : 'watch';
  return freezeEvent({
    id: `${date}:rule:${signal.ruleId}:${signal.type}`,
    setupKey: `rule:${signal.ruleId}:${signal.type}`,
    observedAtIndex: index,
    observedAtDate: date,
    category,
    state: 'confirmed',
    direction: directionForSubtype(subtype),
    action: actionForSubtype(subtype),
    label: signal.label,
    description: compact(signal.description || signal.reason),
    sourceRuleIds: [signal.ruleId],
    sourceFamily: `規則：${subtype}`,
    priority: priorityForSubtype(subtype, 'confirmed'),
  });
}

function mergeDuplicateEvents(events: readonly ChartNarrativeEvent[]): ChartNarrativeEvent[] {
  const merged = new Map<string, ChartNarrativeEvent>();
  for (const event of events) {
    const previous = merged.get(event.setupKey);
    if (!previous) {
      merged.set(event.setupKey, event);
      continue;
    }
    merged.set(event.setupKey, freezeEvent({
      ...previous,
      sourceRuleIds: [...new Set([...previous.sourceRuleIds, ...event.sourceRuleIds])],
      priority: Math.max(previous.priority, event.priority),
    }));
  }
  return [...merged.values()].sort((a, b) => b.priority - a.priority || a.label.localeCompare(b.label, 'zh-Hant'));
}

function resolveAction(
  hasPosition: boolean,
  events: readonly ChartNarrativeEvent[],
  blockers: readonly string[],
): { action: NarrativeAction; tone: NarrativeTone; headline: string } {
  const hasHardExit = events.some(event => event.action === 'exit' && event.state === 'confirmed');
  const hasSoftExit = events.some(event => event.action === 'reduce' && event.state === 'confirmed');
  const hasStrongEntry = events.some(event => event.action === 'evaluate-entry' && event.state === 'confirmed');

  if (hasPosition) {
    if (hasHardExit) return { action: 'exit', tone: 'bearish', headline: '硬出場訊號成立，先處理風險' };
    if (blockers.length > 0) return { action: 'reduce', tone: 'warning', headline: '持股結構轉弱，先保護部位' };
    if (hasSoftExit) return { action: 'reduce', tone: 'warning', headline: '轉弱訊號出現，評估減碼並守停損' };
    return { action: 'hold', tone: 'bullish', headline: '尚無出場條件，依操作均線續抱' };
  }

  if (blockers.length > 0) return { action: 'avoid-entry', tone: 'bearish', headline: '戒律未過，其他多方訊號不構成進場' };
  if (hasHardExit) return { action: 'avoid-entry', tone: 'bearish', headline: '方向轉弱，空手避免逆勢進場' };
  if (hasStrongEntry && hasSoftExit) return { action: 'wait', tone: 'warning', headline: '多空訊號衝突，先等下一根確認' };
  if (hasStrongEntry) return { action: 'evaluate-entry', tone: 'bullish', headline: '進場型態成立，進入風險評估' };
  if (hasSoftExit) return { action: 'avoid-entry', tone: 'warning', headline: '仍有轉弱訊號，暫不搶進' };
  return { action: 'wait', tone: 'neutral', headline: '條件尚未齊備，等待型態確認' };
}

function isDecisionEvidence(event: ChartNarrativeEvent, action: NarrativeAction): boolean {
  if (action === 'hold') return event.category === 'trend';
  if (action === 'wait') return event.state === 'forming' || event.category === 'trend';
  if (action === 'avoid-entry') {
    return event.action === 'avoid-entry' || event.action === 'exit' || event.action === 'reduce';
  }
  return event.action === action;
}

function fallbackConfirmation(
  action: NarrativeAction,
  operatingMA?: string | null,
  blockers: readonly string[] = [],
): string {
  if (action === 'hold' && operatingMA) return `後續收盤持續守住 ${operatingMA}。`;
  if (action === 'exit') return '依既定出場紀律執行，不等待另一個多方訊號抵銷。';
  if (action === 'reduce') return '觀察下一根是否續弱，並同步檢查操作均線與前低。';
  if (action === 'evaluate-entry') return '收盤訊號維持成立，且戒律、位置與停損空間均可接受。';
  if (action === 'avoid-entry') return blockers.length > 0
    ? '目前維持空手；下一根只檢查戒律是否仍存在，不預掛進場單。'
    : '目前維持空手；先觀察轉弱訊號是否繼續，不預判反轉。';
  return '等待下一根 K 棒完成型態或突破／跌破關鍵價。';
}

function fallbackInvalidation(action: NarrativeAction, blockers: readonly string[], operatingMA?: string | null): string {
  if (action === 'exit') return operatingMA
    ? `收盤重新站回 ${operatingMA} 且結構轉強後，才重新判讀；不回頭抵銷當日出場紀律。`
    : '結構重新站回關鍵壓力且出現新確認訊號後，才重做判讀。';
  if (blockers[0]) return `若「${compact(blockers[0], 90)}」解除且結構重新轉強，本次風險判讀失效。`;
  if ((action === 'hold' || action === 'reduce') && operatingMA) return `收盤跌破 ${operatingMA} 時重新評估持股。`;
  if (action === 'evaluate-entry') return '確認前先跌破型態低點或原支撐，進場假設失效。';
  if (action === 'avoid-entry') return '結構重新站回關鍵壓力並出現新的確認訊號，才重做判讀。';
  return '若型態未在後續 K 棒完成，維持觀望。';
}

function classificationFor(
  signal: RuleSignal,
  classifiedSignals: readonly NarrativeClassifiedSignal[],
): SignalSubtype {
  return classifiedSignals.find(item => item.sig === signal)?.subtype ?? classifySignal(signal);
}

export function buildChartNarrative(input: BuildChartNarrativeInput): ChartNarrative {
  const safeIndex = Math.min(input.currentIndex, input.candles.length - 1);
  const current = safeIndex >= 0 ? input.candles[safeIndex] : undefined;
  const date = current?.date ?? 'unknown';
  const prefix = safeIndex >= 0 ? input.candles.slice(0, safeIndex + 1) : [];
  const classifiedSignals = input.classifiedSignals
    ?? input.signals.map(sig => ({ sig, subtype: classifySignal(sig) }));

  const klineEvents = analyzeKLineSignals([...input.signals]).map(analysis => eventForKLine(
    analysis,
    classificationFor(analysis.signal, classifiedSignals),
    safeIndex,
    date,
  ));
  const ruleEvents = input.signals
    .filter(signal => !isKLineSignal(signal))
    .map(signal => eventForSignal(signal, classificationFor(signal, classifiedSignals), safeIndex, date));

  const prohibitionBlockers = input.hasPosition
    ? pickHoldingRiskProhibitions(input.prohibitions ?? [])
    : [...(input.prohibitions ?? [])];
  const hardRisks = [...(input.hardRisks ?? [])];
  const relevantBlockers = [...hardRisks, ...prohibitionBlockers];
  const hardRiskEvent = hardRisks.length > 0
    ? [freezeEvent({
        id: `${date}:risk:hard`,
        setupKey: 'risk:hard',
        observedAtIndex: safeIndex,
        observedAtDate: date,
        category: 'risk',
        state: 'confirmed',
        direction: 'bearish',
        action: input.hasPosition ? 'exit' : 'avoid-entry',
        label: '結構性硬風險',
        description: compact(hardRisks[0]),
        sourceRuleIds: ['structural-risk'],
        sourceFamily: '結構風險',
        priority: 105,
      } satisfies ChartNarrativeEvent)]
    : [];
  const riskEvent = prohibitionBlockers.length > 0
    ? [freezeEvent({
        id: `${date}:risk:prohibition`,
        setupKey: 'risk:prohibition',
        observedAtIndex: safeIndex,
        observedAtDate: date,
        category: 'risk',
        state: 'confirmed',
        direction: 'bearish',
        action: input.hasPosition ? 'reduce' : 'avoid-entry',
        label: input.hasPosition ? '持股戒律警示' : '進場戒律未過',
        description: input.hasPosition
          ? compact(`持倉進入「${prohibitionBlockers[0]}」所描述的風險環境；提高警戒，但是否出場仍以操作均線與硬出場訊號為準。`)
          : compact(prohibitionBlockers[0]),
        sourceRuleIds: ['entry-prohibitions'],
        sourceFamily: '風險戒律',
        priority: 90,
      } satisfies ChartNarrativeEvent)]
    : [];

  let trendState: ChartNarrative['trendState'] = '資料不足';
  let trendPosition: ChartNarrative['trendPosition'] = '資料不足';
  if (prefix.length > 0) {
    trendState = detectTrend(prefix, prefix.length - 1);
    trendPosition = detectTrendPosition(prefix, prefix.length - 1);
  }

  const trendEvent = freezeEvent({
    id: `${date}:trend:${trendState}:${trendPosition}`,
    setupKey: 'trend:current',
    observedAtIndex: safeIndex,
    observedAtDate: date,
    category: 'trend',
    state: 'confirmed',
    direction: trendState === '多頭' ? 'bullish' : trendState === '空頭' ? 'bearish' : 'neutral',
    action: 'wait',
    label: `${trendState}・${trendPosition}`,
    description: '趨勢與所在位置只使用目前日期以前的 K 棒判定。',
    sourceRuleIds: ['trend-analysis'],
    sourceFamily: '趨勢位置',
    priority: 20,
  } satisfies ChartNarrativeEvent);
  // 趨勢是 K 線與規則的解讀背景，每次都保留在證據鏈，不再只在「無訊號」時出現。
  const allEvents = Object.freeze(mergeDuplicateEvents([
    ...klineEvents,
    ...ruleEvents,
    ...hardRiskEvent,
    ...riskEvent,
    trendEvent,
  ]));
  const decision = resolveAction(input.hasPosition, allEvents, relevantBlockers);
  // 主要依據必須和最終動作同一方向；避免「續抱」卻拿買進型態的確認條件當主文。
  const primaryEvent = allEvents.find(event => isDecisionEvidence(event, decision.action)) ?? allEvents[0];
  const secondaryEvents = Object.freeze(allEvents.filter(event => event !== primaryEvent).slice(0, 3));
  const evidenceFamilies = new Set(allEvents.map(event => event.sourceFamily));
  const evidenceLevel = evidenceFamilies.size >= 3 ? 'high' : evidenceFamilies.size === 2 ? 'medium' : 'low';
  const confirmation = primaryEvent.confirmation
    ?? fallbackConfirmation(decision.action, input.operatingMA, relevantBlockers);
  const invalidation = primaryEvent.invalidation ?? fallbackInvalidation(decision.action, relevantBlockers, input.operatingMA);
  const blockers = Object.freeze([...relevantBlockers]);

  return Object.freeze({
    phase: `${trendState} · ${trendPosition}`,
    trendState,
    trendPosition,
    action: decision.action,
    actionLabel: ACTION_LABEL[decision.action],
    tone: decision.tone,
    headline: decision.headline,
    summary: `${primaryEvent.label}：${primaryEvent.description}`,
    confirmation,
    invalidation,
    primaryEvent,
    secondaryEvents,
    events: allEvents,
    blockers,
    evidenceLevel,
  });
}
