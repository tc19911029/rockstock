import type { RuleSignal } from '@/types';

export type KLinePatternFamily =
  | '多方中繼'
  | '空方中繼'
  | '低檔反轉'
  | '高檔反轉'
  | '缺口型態'
  | '單根／合併'
  | '交易確認';

export type KLinePatternDirection = 'bullish' | 'bearish' | 'neutral';
export type KLinePatternState = 'confirmed' | 'forming';

export interface KLineSignalAnalysis {
  signal: RuleSignal;
  family: KLinePatternFamily;
  direction: KLinePatternDirection;
  state: KLinePatternState;
  stateLabel: '多方確認' | '空方確認' | '等待確認';
  interpretation: string;
  confirmation?: string;
  invalidation?: string;
  bookRef?: string;
}

const BULLISH_CONTINUATION = new Set([
  'kline-one-star-two-yang',
  'kline-rising-three-methods',
  'kline-three-line-reverse-red',
  'kline-three-consecutive-red',
  'kline-inner-three-red',
  'kline-red-black-red',
  'kline-small-step-up',
  'kline-down-gap-filled',
]);

const BEARISH_CONTINUATION = new Set([
  'kline-one-star-two-yin',
  'kline-falling-three-methods',
  'kline-three-line-reverse-black',
  'kline-inner-three-black',
  'kline-black-red-black',
  'kline-three-consecutive-black',
]);

const LOW_REVERSAL = new Set([
  'zhu-rising-sun',
  'zhu-bullish-engulfing-low',
  'zhu-bullish-harami-low',
  'zhu-bullish-piercing-low',
  'zhu-bullish-encounter-low',
  'zhu-standard-black-red-low',
  'zhu-morning-star-low',
  'zhu-bullish-mother-son-transition',
  'zhu-bullish-double-star',
  'low-long-red-attack',
  'low-hammer-attack',
  'low-cross-attack',
  'low-engulf-attack',
  'low-three-red-attack',
  'kline-v-shape-reversal-buy',
]);

const HIGH_REVERSAL = new Set([
  'zhu-dark-cloud-cover',
  'zhu-bearish-engulfing-high',
  'zhu-bearish-harami-high',
  'zhu-bearish-piercing-high',
  'zhu-bearish-encounter-high',
  'zhu-standard-red-black-high',
  'zhu-evening-star-high',
  'zhu-bearish-mother-son-transition',
  'zhu-bearish-double-star',
  'top-exhaustion-warning',
  'high-shooting-star',
  'high-cross-sell',
  'high-engulf-sell',
  'high-evening-star',
  'kline-inverted-v-reversal-sell',
  'kline-up-gap-filled',
  'kline-major-resistance-ahead',
]);

const GAP_PATTERNS = new Set([
  'gap-up-long-red',
  'gap-down-long-black',
  'gap-three-day-two-gaps-up',
  'gap-three-day-two-gaps-down',
  'gap-island-reversal',
]);

const SINGLE_OR_MERGED = new Set([
  'candle-merge-signal',
]);

const TRADING_CONFIRMATION = new Set([
  'smart-kline-buy',
  'smart-kline-sell',
  'kline-trading-bull-entry',
  'kline-trading-bull-exit',
]);

const FAMILY_BY_RULE_ID = new Map<string, KLinePatternFamily>([
  ...[...BULLISH_CONTINUATION].map(id => [id, '多方中繼'] as const),
  ...[...BEARISH_CONTINUATION].map(id => [id, '空方中繼'] as const),
  ...[...LOW_REVERSAL].map(id => [id, '低檔反轉'] as const),
  ...[...HIGH_REVERSAL].map(id => [id, '高檔反轉'] as const),
  ...[...GAP_PATTERNS].map(id => [id, '缺口型態'] as const),
  ...[...SINGLE_OR_MERGED].map(id => [id, '單根／合併'] as const),
  ...[...TRADING_CONFIRMATION].map(id => [id, '交易確認'] as const),
]);

const FAMILY_INTERPRETATION: Record<KLinePatternFamily, string> = {
  多方中繼: '多頭趨勢中的整理或換手，結構成立時偏向續攻；仍要確認位置不是高檔末升段。',
  空方中繼: '空頭趨勢中的反彈或整理，結構成立時偏向續跌；低檔出現時要防止反轉。',
  低檔反轉: '原本的下跌力道正在減弱，多方嘗試接手；位置、量能與後續過高決定是否完成反轉。',
  高檔反轉: '原本的上漲力道正在減弱，空方開始取得主控；後續破低會提高轉折向下的可信度。',
  缺口型態: '缺口代表供需突然失衡；方向與強弱要看缺口是否守住、回補，以及所在趨勢位置。',
  '單根／合併': '單根或合併 K 棒只揭示當日多空變化，必須搭配趨勢、位置與下一根 K 棒確認。',
  交易確認: '這是 K 線交易條件的確認訊號，需同時遵守既有停損、位置與趨勢規則。',
};

export function isKLineSignal(signal: RuleSignal): boolean {
  return FAMILY_BY_RULE_ID.has(signal.ruleId);
}

function directionFor(family: KLinePatternFamily, signal: RuleSignal): KLinePatternDirection {
  if (family === '多方中繼' || family === '低檔反轉') return 'bullish';
  if (family === '空方中繼' || family === '高檔反轉') return 'bearish';
  if (signal.type === 'BUY' || signal.type === 'ADD') return 'bullish';
  if (signal.type === 'SELL' || signal.type === 'REDUCE') return 'bearish';
  return 'neutral';
}

function compactText(value: string, maxLength = 150): string {
  const normalized = value.replace(/\s+/g, ' ').trim();
  return normalized.length > maxLength ? `${normalized.slice(0, maxLength - 1)}…` : normalized;
}

function reasonParts(reason: string): string[] {
  return reason
    .replace(/【[^】]+】/g, '')
    .split(/\n|(?<=[。！？])/)
    .map(part => part.trim())
    .filter(Boolean);
}

function firstMatchingReason(reason: string, pattern: RegExp): string | undefined {
  const match = reasonParts(reason).find(part => pattern.test(part));
  return match ? compactText(match) : undefined;
}

export function analyzeKLineSignal(signal: RuleSignal): KLineSignalAnalysis | null {
  const family = FAMILY_BY_RULE_ID.get(signal.ruleId);
  if (!family) return null;

  const direction = directionFor(family, signal);
  const state: KLinePatternState = signal.type === 'WATCH' ? 'forming' : 'confirmed';
  const stateLabel = state === 'forming'
    ? '等待確認'
    : direction === 'bearish'
      ? '空方確認'
      : '多方確認';

  const confirmation = firstMatchingReason(
    signal.reason,
    /(明日|次日|確認|收盤.*(?:突破|跌破)|開高|開低|過高|破低)/,
  );
  const invalidation = firstMatchingReason(
    signal.reason,
    /(破壞|作廢|不能被|否則|失效)/,
  );
  const bookRef = signal.reason.match(/【[^】]+】/)?.[0];

  return {
    signal,
    family,
    direction,
    state,
    stateLabel,
    interpretation: FAMILY_INTERPRETATION[family],
    confirmation,
    invalidation: invalidation === confirmation ? undefined : invalidation,
    bookRef,
  };
}

export function analyzeKLineSignals(signals: RuleSignal[]): KLineSignalAnalysis[] {
  const uniqueSignals = [...new Map(
    signals.map(signal => [`${signal.type}:${signal.ruleId}`, signal] as const),
  ).values()];

  return uniqueSignals
    .map(analyzeKLineSignal)
    .filter((item): item is KLineSignalAnalysis => item !== null)
    .sort((a, b) => {
      if (a.state !== b.state) return a.state === 'confirmed' ? -1 : 1;
      if (a.direction !== b.direction) {
        const order: Record<KLinePatternDirection, number> = { bearish: 0, bullish: 1, neutral: 2 };
        return order[a.direction] - order[b.direction];
      }
      return a.signal.label.localeCompare(b.signal.label, 'zh-Hant');
    });
}
