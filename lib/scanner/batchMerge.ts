/** 合併掃描批次並依 symbol 去重；新批次資料覆蓋同 symbol 的舊資料。 */
export function mergeScanBatchResults<T extends {
  symbol: string;
  sixConditionsScore?: number;
  changePercent: number;
}>(previous: T[], current: T[]): T[] {
  const merged = new Map(previous.map((result) => [result.symbol, result]));
  for (const result of current) merged.set(result.symbol, result);
  return [...merged.values()].sort((a, b) =>
    (b.sixConditionsScore ?? 0) - (a.sixConditionsScore ?? 0) ||
    b.changePercent - a.changePercent,
  );
}
