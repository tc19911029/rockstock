/**
 * 陸股短線情緒股總分模型 — 權重表 + 缺值重加權合成
 *
 * 重加權邏輯複製自 lib/agents/scoring.ts（computeAgentScore），刻意不共用：
 * 兩邊權重表獨立演化，共用一份會讓台股調整掃到陸股回測可比性。
 *
 * 權重（使用者規格書「短線情緒股」，總和 = 1.00）：
 *   情緒 12 / 政策 10 / 題材 15 / 板塊 10 / 漲停結構 15 /
 *   龍虎榜 12 / 主力資金 10 / 人氣熱度 8 / 技術 5 / 風險 3
 *
 * source 欄位：'program' = 程式算分；'skill' = 檔案橋接由 Claude skill
 * 夜間寫入（data/cn-agents/analysis/{date}.json），缺席時自動重加權照常出分。
 */

export const CN_SCORING_VERSION = 'cnv1';

export type CnSignalSource = 'program' | 'skill';

export interface CnSignalSpec {
  key: CnSignalKey;
  label: string;
  weight: number;
  source: CnSignalSource;
  /** core 缺值 → confidence 直接降為 low */
  core?: boolean;
}

export type CnSignalKey =
  | 'emotion'         // 大盤情緒（全市場當日同值）
  | 'policy'          // 政策消息（skill）
  | 'theme'           // 題材熱度（skill + 程式 position 乘數）
  | 'sector'          // 板塊強弱
  | 'limitStructure'  // 漲停結構
  | 'lhb'             // 龍虎榜
  | 'mainFlow'        // 主力資金
  | 'heat'            // 人氣熱度
  | 'technical'       // 技術面
  | 'risk';           // 風險（另有 hard veto 不經總分）

export const CN_EMOTION_SIGNAL_SPECS: CnSignalSpec[] = [
  { key: 'emotion',        label: '大盤情緒', weight: 0.12, source: 'program' },
  { key: 'policy',         label: '政策消息', weight: 0.10, source: 'skill' },
  { key: 'theme',          label: '題材熱度', weight: 0.15, source: 'skill', core: true },
  { key: 'sector',         label: '板塊強弱', weight: 0.10, source: 'program' },
  { key: 'limitStructure', label: '漲停結構', weight: 0.15, source: 'program', core: true },
  { key: 'lhb',            label: '龍虎榜',   weight: 0.12, source: 'program' },
  { key: 'mainFlow',       label: '主力資金', weight: 0.10, source: 'program' },
  { key: 'heat',           label: '人氣熱度', weight: 0.08, source: 'program' },
  { key: 'technical',      label: '技術面',   weight: 0.05, source: 'program' },
  { key: 'risk',           label: '風險',     weight: 0.03, source: 'program' },
];

export type CnScoreLight = 'green' | 'yellow_green' | 'yellow' | 'orange_red' | 'red';

export function cnScoreToLight(score: number): CnScoreLight {
  if (score >= 80) return 'green';
  if (score >= 60) return 'yellow_green';
  if (score >= 40) return 'yellow';
  if (score >= 20) return 'orange_red';
  return 'red';
}

export type CnScoreConfidence = 'high' | 'medium' | 'low';

/** 各子分 0-100；缺值（資料不可得，例：未上榜的 lhb）填 null */
export type CnSubScores = Partial<Record<CnSignalKey, number | null>>;

export interface CnTotalScoreResult {
  scoringVersion: string;
  totalScore: number;
  light: CnScoreLight;
  confidence: CnScoreConfidence;
  dataStatus: { available: CnSignalKey[]; missing: CnSignalKey[] };
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

/**
 * 總分合成：缺值子分剔除分母、餘權等比放大（鏡像 lib/agents/scoring.ts）。
 * 缺值 ≥3 個或 core 缺 → confidence 降檔。
 */
export function computeCnTotalScore(subScores: CnSubScores): CnTotalScoreResult {
  let accum = 0;
  let availableWeight = 0;
  const available: CnSignalKey[] = [];
  const missing: CnSignalKey[] = [];

  for (const spec of CN_EMOTION_SIGNAL_SPECS) {
    const v = subScores[spec.key];
    if (v === null || v === undefined || Number.isNaN(v)) {
      missing.push(spec.key);
      continue;
    }
    available.push(spec.key);
    availableWeight += spec.weight;
    accum += spec.weight * clamp(v, 0, 100);
  }

  const totalScore = availableWeight > 0
    ? clamp(Math.round(accum / availableWeight), 0, 100)
    : 0;

  const coreMissing = CN_EMOTION_SIGNAL_SPECS
    .filter((s) => s.core)
    .some((s) => missing.includes(s.key));
  const confidence: CnScoreConfidence =
    coreMissing || missing.length >= 5 ? 'low'
    : missing.length >= 3 ? 'medium'
    : 'high';

  return {
    scoringVersion: CN_SCORING_VERSION,
    totalScore,
    light: cnScoreToLight(totalScore),
    confidence,
    dataStatus: { available, missing },
  };
}
