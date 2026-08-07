import { isCurrentMarketDate, isLegacyDailyScanFilename } from '@/lib/storage/scanStorage';

describe('scanStorage historical intraday boundary', () => {
  test('歷史日期不應再把 intraday 當成正式日期', () => {
    const now = new Date('2026-08-07T02:00:00.000Z');
    expect(isCurrentMarketDate('2026-08-06', 'TW', now)).toBe(false);
    expect(isCurrentMarketDate('2026-08-06', 'CN', now)).toBe(false);
  });

  test('市場今天仍可顯示盤中快照', () => {
    const now = new Date('2026-08-07T02:00:00.000Z');
    expect(isCurrentMarketDate('2026-08-07', 'TW', now)).toBe(true);
    expect(isCurrentMarketDate('2026-08-07', 'CN', now)).toBe(true);
  });

  test('以各市場時區判斷跨日，不用主機時區', () => {
    const now = new Date('2026-08-06T16:30:00.000Z');
    expect(isCurrentMarketDate('2026-08-07', 'TW', now)).toBe(true);
    expect(isCurrentMarketDate('2026-08-07', 'CN', now)).toBe(true);
  });

  test('舊格式 fallback 不得把 daily30 或字母策略認成 daily', () => {
    expect(isLegacyDailyScanFilename('scan-TW-long-2026-08-06.json', 'TW', 'long')).toBe(true);
    expect(isLegacyDailyScanFilename('scan-TW-2026-08-06.json', 'TW')).toBe(true);
    expect(isLegacyDailyScanFilename('scan-TW-long-daily30-2026-08-06.json', 'TW', 'long')).toBe(false);
    expect(isLegacyDailyScanFilename('scan-TW-long-R-2026-08-06.json', 'TW', 'long')).toBe(false);
    expect(isLegacyDailyScanFilename('scan-TW-long-daily-2026-08-06-intraday-050035.json', 'TW', 'long')).toBe(false);
  });
});
