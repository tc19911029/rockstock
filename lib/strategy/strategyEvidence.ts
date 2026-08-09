export type StrategyEvidenceStatus = 'trade' | 'paper' | 'research';

export type StrategyEvidenceMarket = 'TW' | 'CN';
export type StrategyEvidenceDirection = 'long' | 'short';

export const STRATEGY_AUDIT_DATE = '2026-08-09';
export const STRATEGY_SAMPLE_THROUGH = '2026-06-24';

export const STRATEGY_EVIDENCE_LABELS: Record<StrategyEvidenceStatus, string> = {
  trade: '可交易',
  paper: '紙上觀察',
  research: '型態研究',
};

export const STRATEGY_EVIDENCE_DEFINITIONS: Record<StrategyEvidenceStatus, string> = {
  trade: '跨樣本、成本後與近期樣本皆通過，才可進入實盤規則。',
  paper: '只有特定市場、排序或持有期曾出現訊號；只做紙上追蹤，不代表可下單。',
  research: '尚未證明有穩定超額，只用來觀察型態與累積樣本。',
};

export const PRODUCTION_STRATEGY_IDS = [
  'buy:A',
  'buy:A30',
  'buy:B',
  'buy:C',
  'buy:D',
  'buy:E',
  'buy:F',
  'buy:J',
  'buy:K',
  'buy:L',
  'buy:M',
  'buy:N',
  'buy:O',
  'buy:P',
  'buy:Q',
  'r:long',
  'r:short',
  'buy:Y',
  'sanse:strict',
  'sanse:medium',
  'sanse:loose',
  'sanse:reversal',
  'sanse:resonance',
  'sanse:red_yellow_trigger',
  'sanse:red_dualb_gold',
  'sanse:red_dualb_any',
  'daban',
  'backend:V',
  'backend:W',
  'backend:X',
] as const;

export type ProductionStrategyId = (typeof PRODUCTION_STRATEGY_IDS)[number];

export interface StrategyEvidence {
  id: ProductionStrategyId;
  status: StrategyEvidenceStatus;
  label: string;
  rationale: string;
  constraint?: string;
  auditedAt: string;
  sampleThrough: string;
}

interface PaperObservation {
  id: ProductionStrategyId;
  market: StrategyEvidenceMarket;
  rationale: string;
  constraint: string;
}

/**
 * 僅代表統一重跑後仍值得繼續收集紙上樣本的切片。
 * 這些切片沒有一個達到「可交易」門檻。
 */
export const PAPER_OBSERVATIONS: readonly PaperObservation[] = [
  {
    id: 'buy:E',
    market: 'CN',
    rationale: '陸股 20 日切片在 train/test 皆為正，但中位數為負且近期樣本轉弱。',
    constraint: '只觀察陸股、持有 20 日；不得外推到其他持有期。',
  },
  {
    id: 'buy:F',
    market: 'CN',
    rationale: '陸股 1 日切片的成本後超額為正，但近期 OOS 已轉負且多重檢定後僅屬邊界訊號。',
    constraint: '只觀察陸股、次日開盤進出與持有 1 日。',
  },
  {
    id: 'buy:M',
    market: 'CN',
    rationale: '陸股 20 日切片為正，但結果依賴少數右尾樣本，年度與中位數不穩。',
    constraint: '只觀察陸股、持有 20 日，並追蹤尾端依賴。',
  },
  {
    id: 'backend:X',
    market: 'TW',
    rationale: '台股 20 日全期成本後略為正，但 train/test 異號且股票覆蓋不足。',
    constraint: '後台紙上觀察；補齊資料覆蓋並取得新 OOS 前不得升級。',
  },
] as const;

export const R_SHORT_TOP1_PAPER_CANDIDATE = {
  label: '陸股 R 做空 Top1',
  status: 'paper' as const,
  market: 'CN' as const,
  constraint: '現行做空按鈕是 Top10，測試段為負；Top1 是不同的未上線窄切片，不能共用證據等級。',
};

export const SANSE_NARROW_PAPER_CANDIDATE = {
  label: '紅機構＋零軸下捕撈金叉＋量能放大',
  status: 'paper' as const,
  market: 'CN' as const,
  constraint: '這是尚未做成介面按鈕的窄條件；近期 OOS 已反轉，不能套用到現有「三色(底反)」按鈕。',
};

const DEFAULT_RESEARCH_RATIONALE = '統一重跑後，尚未出現跨樣本、成本後且近期一致的穩定超額。';

export function getStrategyEvidence(
  id: ProductionStrategyId,
  market: StrategyEvidenceMarket,
): StrategyEvidence {
  const paper = PAPER_OBSERVATIONS.find(item => item.id === id && item.market === market);
  const status: StrategyEvidenceStatus = paper ? 'paper' : 'research';

  return {
    id,
    status,
    label: STRATEGY_EVIDENCE_LABELS[status],
    rationale: paper?.rationale ?? DEFAULT_RESEARCH_RATIONALE,
    constraint: paper?.constraint,
    auditedAt: STRATEGY_AUDIT_DATE,
    sampleThrough: STRATEGY_SAMPLE_THROUGH,
  };
}

export function getBuyMethodEvidence(
  method: string,
  market: StrategyEvidenceMarket,
  direction: StrategyEvidenceDirection = 'long',
): StrategyEvidence {
  if (method === 'R') {
    return getStrategyEvidence(direction === 'short' ? 'r:short' : 'r:long', market);
  }

  const id = `buy:${method}` as ProductionStrategyId;
  if (!PRODUCTION_STRATEGY_IDS.includes(id)) {
    throw new Error(`Unknown buy method evidence id: ${method}`);
  }
  return getStrategyEvidence(id, market);
}

export function getSanSeEvidence(
  level: string,
  market: StrategyEvidenceMarket,
): StrategyEvidence {
  const id = `sanse:${level}` as ProductionStrategyId;
  if (!PRODUCTION_STRATEGY_IDS.includes(id)) {
    throw new Error(`Unknown SanSe evidence id: ${level}`);
  }
  return getStrategyEvidence(id, market);
}

export function formatStrategyEvidenceTooltip(evidence: StrategyEvidence): string {
  return [
    `證據分級：${evidence.label}`,
    evidence.rationale,
    evidence.constraint,
    `審計日 ${evidence.auditedAt}；樣本截至 ${evidence.sampleThrough}`,
  ].filter(Boolean).join('\n');
}
