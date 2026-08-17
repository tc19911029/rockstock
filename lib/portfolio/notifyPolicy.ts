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
}

export function canPushPortfolioAction(item: PortfolioNotifyCandidate): boolean {
  return ACTIONABLE.has(item.action) && item.intradayProvisional !== true;
}
