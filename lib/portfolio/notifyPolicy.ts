/**
 * 持倉通知的單一准入規則。
 *
 * 收盤級策略在盤中只會得到尚未完成的半根 K；這類結果可以留在畫面上
 * 作為預警，但不可升級成「現在掛單」的正式手機通知。
 */
const ACTIONABLE = new Set([
  'stop_loss',
  'exit_all',
  'reduce_half',
  'watch_stop',
  'cover_all',
]);

export interface PortfolioNotifyCandidate {
  action: string;
  intradayProvisional?: boolean;
  notificationBasis?: 'price' | 'close';
  asOfDate?: string | null;
  expectedDate?: string;
}

export interface PortfolioNotifyContext {
  executionWindow?: boolean;
}

const INTRADAY_PRICE_SIGNAL_TYPES = new Set([
  'absolute_stop',
  'hard_stop_10pct',
  'entry_kline_low_break',
  'short_stop_cover',
  'near_stop',
  'short_near_cover_stop',
  'loss_over_5pct',
  'day_drop_over_5pct',
]);

export function classifyPortfolioNotificationBasis(
  signals: ReadonlyArray<{ type: string }>,
): 'price' | 'close' {
  return signals.some(signal => INTRADAY_PRICE_SIGNAL_TYPES.has(signal.type)) ? 'price' : 'close';
}

export function formatPortfolioProfitPct(value: number | null | undefined): string {
  return value != null && Number.isFinite(value) ? `${(value * 100).toFixed(1)}%` : '?';
}

export function canPushPortfolioAction(
  item: PortfolioNotifyCandidate,
  context: PortfolioNotifyContext = {},
): boolean {
  if (!ACTIONABLE.has(item.action)) return false;
  if (item.expectedDate && item.asOfDate !== item.expectedDate) return false;
  if (item.intradayProvisional !== true) return true;
  if (item.notificationBasis === 'price') return true;
  return context.executionWindow === true;
}
