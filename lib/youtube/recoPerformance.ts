/**
 * thin re-export — 2026-06-13 起單一事實在 lib/backtest/eventReturns.ts
 * （陸股情緒回測迴圈共用；指數參數注入，傳 000001.SS 即可算陸股超額）。
 * 既有 youtube 呼叫方與測試零行為變更。
 */

export { computeEventReturns, indexReturnBetween, evalTargetStop } from '@/lib/backtest/eventReturns';
export type { TargetStopEval } from '@/lib/backtest/eventReturns';
