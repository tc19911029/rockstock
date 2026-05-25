/**
 * computeFacetVerdicts — 規則式推 4 面向 verdict
 *
 * 用於 DecisionPanel 在 multi-agent 未跑時的 fallback、讓 user 永遠看得到
 * 4 verdict 卡（技術/消息/籌碼/基本）— 而不是空白等 user 手動 trigger skill。
 *
 * 規則對齊書本 + 既有 lib：
 *   - 技術：六條件分數 + 戒律觸發降級
 *   - 消息：YouTube 提及次數 + 高共識
 *   - 籌碼：chipScore (0-100)
 *   - 基本：EPS YoY + 月營收 YoY
 *
 * 純函數、不打 IO、可重複呼叫、合約測試保證一致。
 */

export type FacetVerdict = 'pass' | 'watch' | 'fail';

export interface FacetVerdictsInput {
  /** 六條件分數 0-6（從 scan 結果或 pool candidate.sources.technical.sixConditionsScore）*/
  sixConditionsScore?: number | null;
  /** 戒律觸發 — 命中任一即降級 */
  prohibitionHit?: boolean | null;
  /** YouTube 節目提及次數（candidate.strengthSignals.youtubeMentionCount）*/
  youtubeMentionCount?: number | null;
  /** 高共識（≥2 節目同向）— candidate.sources.youtube.inHighConsensus */
  youtubeInHighConsensus?: boolean | null;
  /** 籌碼分數 0-100（candidate.sources.chip.chipScore 或 /api/chip chipScore）*/
  chipScore?: number | null;
  /** EPS 年增率 % （/api/fundamentals epsYoY）*/
  epsYoY?: number | null;
  /** 月營收年增率 % （/api/fundamentals revenueYoY）*/
  revenueYoY?: number | null;
}

export interface FacetVerdictsResult {
  technical: FacetVerdict;
  news: FacetVerdict;
  chip: FacetVerdict;
  fundamental: FacetVerdict;
  hints: {
    technical: string;
    news: string;
    chip: string;
    fundamental: string;
  };
}

/** 純函數：規則推估 4 面向 verdict + 一句話 hint */
export function computeFacetVerdicts(input: FacetVerdictsInput): FacetVerdictsResult {
  // ── 技術 ────────────────────────────────────────────────────────────────
  const six = input.sixConditionsScore ?? 0;
  const techBase: FacetVerdict = six >= 6 ? 'pass' : six >= 5 ? 'watch' : 'fail';
  const technical: FacetVerdict = input.prohibitionHit
    ? (techBase === 'pass' ? 'watch' : 'fail')
    : techBase;

  // ── 消息 ────────────────────────────────────────────────────────────────
  const mc = input.youtubeMentionCount ?? 0;
  const news: FacetVerdict = (mc >= 2 && input.youtubeInHighConsensus) ? 'pass'
    : mc >= 1 ? 'watch'
    : 'fail';

  // ── 籌碼 ────────────────────────────────────────────────────────────────
  const cs = input.chipScore;
  const chip: FacetVerdict = cs == null ? 'fail'
    : cs >= 70 ? 'pass'
    : cs >= 40 ? 'watch'
    : 'fail';

  // ── 基本 ────────────────────────────────────────────────────────────────
  // null 視為「無資料」、不影響判定（用 0 fallback 仍能比較）
  const eps = input.epsYoY ?? 0;
  const rev = input.revenueYoY ?? 0;
  const hasFund = input.epsYoY != null || input.revenueYoY != null;
  const fundamental: FacetVerdict = !hasFund ? 'fail'
    : (eps > 0 && rev > 0) ? 'pass'
    : (eps > 0 || rev > 0) ? 'watch'
    : 'fail';

  return {
    technical,
    news,
    chip,
    fundamental,
    hints: {
      technical: `六條件 ${six}/6${input.prohibitionHit ? '、戒律觸發' : ''}`,
      news: mc > 0
        ? `YouTube ${mc} 節提及${input.youtubeInHighConsensus ? '、高共識' : ''}`
        : '無 YouTube 提及',
      chip: cs != null ? `籌碼分數 ${cs}/100` : '無籌碼資料',
      fundamental: hasFund
        ? `EPS YoY ${eps.toFixed(1)}%、營收 YoY ${rev.toFixed(1)}%`
        : '無基本面資料',
    },
  };
}
