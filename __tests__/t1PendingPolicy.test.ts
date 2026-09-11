import { classifyT1Pending } from '@/lib/datasource/t1PendingPolicy';
import type { IntradayQuote, IntradaySnapshot } from '@/lib/datasource/IntradayCache';
import { MIN_VERIFY_UNIVERSE } from '@/lib/datasource/DownloadVerifier';

function snapshot(market: 'TW' | 'CN'): IntradaySnapshot {
  const quotes: IntradayQuote[] = Array.from({ length: MIN_VERIFY_UNIVERSE[market] }, (_, i) => ({
    symbol: String(i), name: 'test', open: 10, high: 10, low: 10, close: 10,
    prevClose: 10, changePercent: 0, volume: 100,
  }));
  quotes[1] = { ...quotes[1], volume: 0, isActualTrade: false };
  return { market, date: '2026-09-10', updatedAt: '2026-09-10T08:00:00Z', count: quotes.length, quotes };
}

describe.each(['TW', 'CN'] as const)('T+1 %s pending 分流', market => {
  const suffix = market === 'TW' ? 'TW' : 'SZ';
  const active = { symbol: `0.${suffix}` };
  const noTrade = { symbol: `1.${suffix}` };
  const absent = { symbol: `missing.${suffix}` };
  const index = { symbol: '^INDEX' };
  const entries = [active, noTrade, absent, index];

  test('完整同日收盤快照：交易股保留，零成交、缺席與指數分流', () => {
    expect(classifyT1Pending(market, '2026-09-10', entries, snapshot(market))).toEqual({
      pending: [active], confirmedNoTrade: [noTrade], notTrading: [absent], externalManaged: [index],
    });
  });

  test.each(['missing', 'intraday', 'wrongDate', 'wrongMarket', 'small', 'duplicates'])(
    '%s 快照不能排除待補個股', kind => {
      const s = snapshot(market);
      if (kind === 'intraday') s.updatedAt = '2026-09-10T04:00:00Z';
      if (kind === 'wrongDate') s.date = '2026-09-09';
      if (kind === 'wrongMarket') s.market = market === 'TW' ? 'CN' : 'TW';
      if (kind === 'small') { s.quotes = s.quotes.slice(0, 2); s.count = 2; }
      if (kind === 'duplicates') s.quotes = s.quotes.map(() => s.quotes[0]);
      expect(classifyT1Pending(market, '2026-09-10', entries, kind === 'missing' ? null : s)).toEqual({
        pending: [active, noTrade, absent], confirmedNoTrade: [], notTrading: [], externalManaged: [index],
      });
    },
  );
});
