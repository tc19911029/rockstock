import { getQuoteSnapshotDate } from '@/lib/datasource/marketHours';

describe('portfolio quote L2 fallback snapshot date', () => {
  test('交易日開盤前回退到上一交易日', () => {
    const preMarket = new Date('2026-08-14T00:23:00.000Z'); // CST 08:23
    expect(getQuoteSnapshotDate('TW', preMarket)).toBe('2026-08-13');
    expect(getQuoteSnapshotDate('CN', preMarket)).toBe('2026-08-13');
  });

  test('市場開始交易後使用今天的快照', () => {
    expect(getQuoteSnapshotDate('TW', new Date('2026-08-14T01:00:00.000Z'))).toBe('2026-08-14');
    expect(getQuoteSnapshotDate('CN', new Date('2026-08-14T01:15:00.000Z'))).toBe('2026-08-14');
  });

  test('休市日回退並跳過週末與假日', () => {
    expect(getQuoteSnapshotDate('TW', new Date('2026-10-10T04:00:00.000Z'))).toBe('2026-10-08');
    expect(getQuoteSnapshotDate('CN', new Date('2026-10-06T04:00:00.000Z'))).toBe('2026-09-30');
  });
});
