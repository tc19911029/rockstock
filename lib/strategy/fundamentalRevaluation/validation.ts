import type { FundamentalRevaluationSession } from './types';

export interface FundamentalSessionValidation {
  valid: boolean;
  reason?: string;
  evaluatedCount: number;
  evaluatedRatio: number;
}

const MIN_CANDIDATES: Record<'TW' | 'CN', number> = { TW: 200, CN: 200 };

/** 防止「route 成功、實際上 0 檔完成評估」的空殼結果寫盤。 */
export function validateFundamentalSession(
  session: FundamentalRevaluationSession,
): FundamentalSessionValidation {
  const excluded = Object.values(session.exclusionLists)
    .reduce((sum, entries) => sum + entries.length, 0);
  const evaluatedCount = session.top100.length + excluded;
  const evaluatedRatio = session.totalCandidates > 0
    ? evaluatedCount / session.totalCandidates
    : 0;

  if (session.totalCandidates < MIN_CANDIDATES[session.market]) {
    return {
      valid: false,
      reason: `候選母體 ${session.totalCandidates} < ${MIN_CANDIDATES[session.market]}`,
      evaluatedCount,
      evaluatedRatio,
    };
  }
  if (evaluatedCount === 0 || evaluatedRatio < 0.5) {
    return {
      valid: false,
      reason: `實際完成評估 ${evaluatedCount}/${session.totalCandidates} (${(evaluatedRatio * 100).toFixed(1)}%)`,
      evaluatedCount,
      evaluatedRatio,
    };
  }
  return { valid: true, evaluatedCount, evaluatedRatio };
}
