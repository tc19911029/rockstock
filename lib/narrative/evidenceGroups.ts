import type {
  ChartNarrativeEvent,
  NarrativeAction,
  NarrativeEvidenceDisposition,
  NarrativeEvidenceGroup,
} from './types';

const DISPOSITION_ORDER: Record<NarrativeEvidenceDisposition, number> = {
  adopted: 0,
  conflicting: 1,
  background: 2,
};

function dispositionForEvent(
  event: ChartNarrativeEvent,
  action: NarrativeAction,
): NarrativeEvidenceDisposition {
  if (event.category === 'trend') {
    return action === 'hold' ? 'adopted' : 'background';
  }

  if (action === 'exit') {
    if (event.action === 'exit') return 'adopted';
    return event.direction === 'bullish' ? 'conflicting' : 'background';
  }

  if (action === 'reduce') {
    if (event.category === 'risk' || event.action === 'reduce' || event.action === 'exit') return 'adopted';
    return event.direction === 'bullish' ? 'conflicting' : 'background';
  }

  if (action === 'avoid-entry') {
    if (event.category === 'risk' || event.action === 'reduce' || event.action === 'exit') return 'adopted';
    return event.direction === 'bullish' ? 'conflicting' : 'background';
  }

  if (action === 'evaluate-entry') {
    if (event.action === 'evaluate-entry') return 'adopted';
    return event.direction === 'bearish' || event.category === 'risk' ? 'conflicting' : 'background';
  }

  if (action === 'hold') {
    if (event.direction === 'bearish' || event.category === 'risk') return 'conflicting';
    return 'background';
  }

  if (event.state === 'forming') return 'adopted';
  return 'background';
}

function clusterKey(event: ChartNarrativeEvent): string {
  if (event.category === 'kline') {
    return `kline:${event.observedAtDate}:${event.direction}`;
  }
  if (event.category === 'trend') return 'trend:current';
  if (event.category === 'risk') return `risk:${event.setupKey}`;
  return `${event.category}:${event.direction}`;
}

function clusterLabel(event: ChartNarrativeEvent): string {
  if (event.category === 'kline') {
    const direction = event.direction === 'bullish' ? '多方' : event.direction === 'bearish' ? '空方' : '中性';
    return `${direction} K 線型態`;
  }
  if (event.category === 'trend') return '趨勢背景';
  if (event.category === 'risk') return event.label;
  if (event.category === 'exit') return '出場規則';
  if (event.category === 'entry') return '進場規則';
  return '觀察規則';
}

export function groupNarrativeEvidence(
  events: readonly ChartNarrativeEvent[],
  action: NarrativeAction,
): NarrativeEvidenceGroup[] {
  const buckets = new Map<string, ChartNarrativeEvent[]>();
  for (const event of events) {
    const key = clusterKey(event);
    buckets.set(key, [...(buckets.get(key) ?? []), event]);
  }

  return [...buckets.entries()]
    .map(([key, groupedEvents]) => {
      const sorted = groupedEvents.slice().sort((a, b) => b.priority - a.priority);
      const first = sorted[0];
      const group = Object.freeze({
        key,
        disposition: dispositionForEvent(first, action),
        category: first.category,
        direction: first.direction,
        label: clusterLabel(first),
        eventCount: sorted.length,
        eventLabels: Object.freeze(sorted.map(event => event.label)),
        priority: first.priority,
      } satisfies NarrativeEvidenceGroup);
      return group;
    })
    .sort((a, b) => (
      DISPOSITION_ORDER[a.disposition] - DISPOSITION_ORDER[b.disposition]
      || b.priority - a.priority
      || a.label.localeCompare(b.label, 'zh-Hant')
    ));
}
