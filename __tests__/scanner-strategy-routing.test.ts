import type { CandleWithIndicators } from '@/types';
import { MarketScanner } from '@/lib/scanner/MarketScanner';
import type { MarketConfig, StockScanResult } from '@/lib/scanner/types';
import { ZHU_ABC_BREAKOUT, ZHU_PURE_BOOK } from '@/lib/strategy/StrategyConfig';

class StrategyTestScanner extends MarketScanner {
  getMarketConfig(): MarketConfig {
    return { marketId: 'TW', name: 'test', scanTimeLocal: '13:30', timezone: 'Asia/Taipei' };
  }

  async getStockList() { return []; }
  async fetchCandles(): Promise<CandleWithIndicators[]> { return []; }
  async getMarketTrend() { return '多頭' as const; }
}

describe('MarketScanner strategy routing', () => {
  test('uses only the configured strategy rule groups', () => {
    const scanner = new StrategyTestScanner();
    scanner.configureStrategy(ZHU_PURE_BOOK);
    const configured = new Set(scanner.getConfiguredRuleIds());

    expect(configured.size).toBeGreaterThan(0);
    expect(configured.has('granville-buy-1')).toBe(false);
    expect(configured.has('zhu-turning-wave-20ma-bull')).toBe(false);
  });

  test('routes a standalone k-line strategy to its detector without the A gate', async () => {
    const scanner = new StrategyTestScanner();
    scanner.configureStrategy(ZHU_ABC_BREAKOUT);
    const result: StockScanResult = {
      symbol: '2330.TW', name: '台積電', market: 'TW', price: 100, changePercent: 1, volume: 1,
      triggeredRules: [], sixConditionsScore: 0,
      sixConditionsBreakdown: { trend: false, ma: false, position: false, volume: false, kbar: false, indicator: false },
      trendState: '盤整', trendPosition: '盤整觀望', scanTime: '2026-08-17T00:00:00.000Z',
      matchedMethods: ['J'],
    };
    const detector = jest.spyOn(scanner, 'scanBuyMethod').mockResolvedValue([result]);

    const out = await scanner.scanSOP([{ symbol: '2330.TW', name: '台積電' }], '2026-08-17', ZHU_ABC_BREAKOUT.thresholds);

    expect(detector).toHaveBeenCalledWith('J', expect.any(Array), '2026-08-17', expect.objectContaining({ skipStep1Gate: true }));
    expect(out.results).toEqual([result]);
  });
});
