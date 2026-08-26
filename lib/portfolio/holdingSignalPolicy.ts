import type { SignalSubtype } from '@/lib/rules/signalClassifier';
import type { RuleSignal } from '@/types';

type MovingAverageName = 'MA3' | 'MA5' | 'MA10' | 'MA20' | 'MA60';

const MA_RANK: Readonly<Record<MovingAverageName, number>> = Object.freeze({
  MA3: 1,
  MA5: 2,
  MA10: 3,
  MA20: 4,
  MA60: 5,
});

const MA_PATTERNS: ReadonlyArray<{
  readonly name: MovingAverageName;
  readonly patterns: readonly RegExp[];
}> = [
  { name: 'MA60', patterns: [/MA\s*60(?!\d)/i, /(?:60|六十)\s*日(?:移動)?均線/, /(?:60|六十)\s*日線/, /季線/] },
  { name: 'MA20', patterns: [/MA\s*20(?!\d)/i, /(?:20|二十)\s*日(?:移動)?均線/, /(?:20|二十)\s*日線/, /月線/] },
  { name: 'MA10', patterns: [/MA\s*10(?!\d)/i, /(?:10|十)\s*日(?:移動)?均線/, /(?:10|十)\s*日線/] },
  { name: 'MA5', patterns: [/MA\s*5(?!\d)/i, /(?:5|五)\s*日(?:移動)?均線/, /(?:5|五)\s*日線/] },
  { name: 'MA3', patterns: [/MA\s*3(?!\d)/i, /(?:3|三)\s*日(?:移動)?均線/, /(?:3|三)\s*日線/] },
];

/**
 * 這些是全市場走圖用的「情境規則」，不是持倉的正式出場 gate。
 * 持倉是否出場必須由 holdingsActionEngine 依進場字母、操作模式與操作均線確認；
 * 否則一般 MA5 持倉會被飆股專用的 MA3／前日低規則越權改寫。
 */
const HOLDING_INFORMATION_ONLY_RULE_IDS: ReadonlySet<string> = new Set([
  'surge-stock-exit',
  'zhu-surge-hold-or-sell',
]);

export function movingAverageRank(name?: string | null): number | null {
  if (!name) return null;
  return MA_RANK[name.toUpperCase() as MovingAverageName] ?? null;
}

/**
 * 從中英文顯示文字辨識唯一一條均線。一次提到多條均線時回傳 null，
 * 避免把「MA5/MA20 多頭排列」誤認成單一出場線。
 */
export function movingAverageRankFromText(value: string): number | null {
  const normalized = value.normalize('NFKC');
  const hits = MA_PATTERNS
    .filter(item => item.patterns.some(pattern => pattern.test(normalized)))
    .map(item => item.name);
  return hits.length === 1 ? MA_RANK[hits[0]] : null;
}

export function movingAverageRankFromSignal(signal: RuleSignal): number | null {
  return movingAverageRankFromText([
    signal.ruleId,
    signal.label,
    signal.description,
    signal.reason,
  ].filter(Boolean).join(' '));
}

/**
 * 將全市場走圖訊號收斂到「這一筆持倉」的策略情境。
 *
 * - 飆股顯示規則：持倉中只保留資訊，不直接產生交易動作。
 * - 比操作均線更短的硬出場：降為轉弱警示；真正全出仍等正式持倉引擎確認。
 * - 同一條或更長週期的硬訊號：維持原分類。
 */
export function resolveHoldingSignalSubtype({
  signal,
  subtype,
  hasPosition,
  operatingMA,
}: {
  signal: RuleSignal;
  subtype: SignalSubtype;
  hasPosition: boolean;
  operatingMA?: string | null;
}): SignalSubtype {
  if (!hasPosition) return subtype;

  if (HOLDING_INFORMATION_ONLY_RULE_IDS.has(signal.ruleId)) {
    return 'warn';
  }

  if (subtype !== 'exit_strong') return subtype;
  const operationRank = movingAverageRank(operatingMA);
  const signalRank = movingAverageRankFromSignal(signal);
  if (operationRank != null && signalRank != null && signalRank < operationRank) {
    return 'exit_soft';
  }
  return subtype;
}
