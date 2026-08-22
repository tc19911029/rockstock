import { buildValuationPollingUrls } from '@/lib/valuation/polling';

describe('valuation polling', () => {
  it('跨午夜後仍固定查詢背景工作啟動日', () => {
    const urls = buildValuationPollingUrls('5475', '2026-08-22', Date.parse('2026-08-23T00:01:00+08:00'));

    expect(urls.valuationUrl).toContain('date=2026-08-22');
    expect(urls.statusUrl).toContain('date=2026-08-22');
    expect(urls.valuationUrl).not.toContain('date=2026-08-23');
  });

  it('拒絕無效工作日期，避免靜默輪詢錯誤路徑', () => {
    expect(() => buildValuationPollingUrls('5475', '2026/08/22', 1)).toThrow('invalid valuation job date');
  });
});
