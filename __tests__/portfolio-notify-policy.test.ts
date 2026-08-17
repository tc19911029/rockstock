import {
  canPushPortfolioAction,
  classifyPortfolioNotificationBasis,
  formatPortfolioProfitPct,
  portfolioNotificationPhase,
} from '@/lib/portfolio/notifyPolicy';

describe('portfolio notify policy', () => {
  test('blocks provisional half-bar actions, including the execution window', () => {
    expect(canPushPortfolioAction({ action: 'stop_loss', intradayProvisional: true })).toBe(false);
    expect(canPushPortfolioAction({ action: 'exit_all', intradayProvisional: true })).toBe(false);
  });

  test('allows confirmed actionable results only', () => {
    expect(canPushPortfolioAction({ action: 'stop_loss', intradayProvisional: false })).toBe(true);
    expect(canPushPortfolioAction({ action: 'cover_all' })).toBe(true);
    expect(canPushPortfolioAction({ action: 'hold' })).toBe(false);
    expect(canPushPortfolioAction({ action: 'no_data' })).toBe(false);
  });

  test('allows price triggers intraday and close signals only in the execution window', () => {
    expect(canPushPortfolioAction({
      action: 'stop_loss', intradayProvisional: true, notificationBasis: 'price',
      asOfDate: '2026-08-17', expectedDate: '2026-08-17',
    })).toBe(true);
    expect(canPushPortfolioAction({
      action: 'exit_all', intradayProvisional: true, notificationBasis: 'close',
      asOfDate: '2026-08-17', expectedDate: '2026-08-17',
    }, { executionWindow: true })).toBe(true);
  });

  test('rejects stale candles even when they look confirmed', () => {
    expect(canPushPortfolioAction({
      action: 'stop_loss', intradayProvisional: false, notificationBasis: 'price',
      asOfDate: '2026-08-16', expectedDate: '2026-08-17',
    })).toBe(false);
  });

  test('classifies trigger basis and formats decimal returns as percentages', () => {
    expect(classifyPortfolioNotificationBasis([{ type: 'absolute_stop' }])).toBe('price');
    expect(classifyPortfolioNotificationBasis([{ type: 'break_ma5_high_profit' }])).toBe('close');
    expect(formatPortfolioProfitPct(0.13)).toBe('13.0%');
  });

  test('dedup phase never creates a third post-close notification', () => {
    expect(portfolioNotificationPhase('TW', '09:30')).toBe('initial');
    expect(portfolioNotificationPhase('TW', '13:20', true)).toBe('exec');
    expect(portfolioNotificationPhase('TW', '13:45')).toBe('exec');
    expect(portfolioNotificationPhase('CN', '15:10')).toBe('exec');
  });
});
