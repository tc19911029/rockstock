import { canPushPortfolioAction } from '@/lib/portfolio/notifyPolicy';

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
});
