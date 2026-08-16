export interface ExactConcentrationPoint {
  date: string;
  c5: number | null;
  c20: number | null;
  net?: number | null;
}

export type ExactConcentrationAvailability = 'ready' | 'partial' | 'unavailable';

export interface ExactConcentrationAssessment {
  status: ExactConcentrationAvailability;
  totalCount: number;
  exactDateCount: number;
  latestDate: string | null;
  latestComplete: boolean;
}

const isFiniteNumber = (value: number | null | undefined): value is number =>
  typeof value === 'number' && Number.isFinite(value);

/**
 * 判斷「正式 5／20 日分點集中度」是否真的可用。
 *
 * API 回應成功只代表請求完成，不代表資料完整；FinMind 限流或權限不足時，
 * 可能回傳日期列但 c5/c20 全為 null。這種情況不得標示成 ready。
 */
export function assessExactConcentration(
  rows: readonly ExactConcentrationPoint[],
): ExactConcentrationAssessment {
  const sorted = rows.slice().sort((a, b) => b.date.localeCompare(a.date));
  const latest = sorted[0] ?? null;
  const exactDateCount = rows.filter(row => (
    isFiniteNumber(row.c5) || isFiniteNumber(row.c20)
  )).length;
  const latestComplete = !!latest
    && isFiniteNumber(latest.c5)
    && isFiniteNumber(latest.c20);

  return {
    status: latestComplete
      ? 'ready'
      : exactDateCount > 0
        ? 'partial'
        : 'unavailable',
    totalCount: rows.length,
    exactDateCount,
    latestDate: latest?.date ?? null,
    latestComplete,
  };
}
