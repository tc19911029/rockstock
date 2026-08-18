import type { Pivot } from '@/lib/analysis/trendAnalysis';

export interface SelectablePatternCandidate {
  pivots: Pivot[];
  qualityScore?: number;
}

/** 多空同時成立時先比結構品質，再以最近腳位破同分。 */
export function choosePatternCandidate<
  TBottom extends SelectablePatternCandidate,
  TTop extends SelectablePatternCandidate,
>(
  bottom: TBottom | null,
  top: TTop | null,
): TBottom | TTop | null {
  if (!bottom) return top;
  if (!top) return bottom;
  const qualityDiff = (top.qualityScore ?? 0) - (bottom.qualityScore ?? 0);
  if (qualityDiff !== 0) return qualityDiff > 0 ? top : bottom;
  const latestPivot = (candidate: SelectablePatternCandidate) =>
    Math.max(...candidate.pivots.map(pivot => pivot.index));
  return latestPivot(top) > latestPivot(bottom) ? top : bottom;
}
