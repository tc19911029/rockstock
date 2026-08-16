import {
  DATA_SOURCE_RESILIENCE,
  assessDataSourceResilience,
  summarizeDataSourceResilience,
} from '@/lib/datasource/DataSourceResilience';

describe('關鍵資料源韌性契約', () => {
  test('所有關鍵資料都有明確備援與非靜默失敗模式', () => {
    for (const entry of DATA_SOURCE_RESILIENCE.filter((item) => item.critical)) {
      expect(entry.fallbacks.length).toBeGreaterThan(0);
      expect(entry.failureMode).not.toBe('unavailable');
      expect(assessDataSourceResilience(entry)).not.toBe('unprotected');
    }
  });

  test('主力分點只有估算／舊快取時必須標為安全降級，不能冒充完整備援', () => {
    const branch = DATA_SOURCE_RESILIENCE.find((entry) => entry.id === 'tw-broker-concentration');
    expect(branch).toBeDefined();
    expect(assessDataSourceResilience(branch!)).toBe('degraded');
    expect(branch!.failureMode).toBe('show_approximate');
    expect(branch!.fallbacks.some((fallback) => fallback.quality === 'approximate')).toBe(true);
  });

  test('健康摘要不可出現無備援項目', () => {
    const summary = summarizeDataSourceResilience();
    expect(summary.total).toBe(DATA_SOURCE_RESILIENCE.length);
    expect(summary.unprotected).toBe(0);
  });
});
