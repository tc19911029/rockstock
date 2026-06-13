/**
 * thin re-export — 2026-06-13 起單一事實在 lib/backtest/eventBaseline.ts
 * （陸股情緒回測迴圈共用；一字板 no_fill 守衛不可 fork）。
 * 既有 youtube 呼叫方與測試零行為變更。
 */

export { settleBaseline } from '@/lib/backtest/eventBaseline';
export type { BaselineCandle } from '@/lib/backtest/eventBaseline';
