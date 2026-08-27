import { isRecoveryPayloadHealthy } from '@/app/api/cron/quote-freshness-watchdog/route';

describe('quote watchdog recovery semantics', () => {
  test('HTTP 200 但 body 告警時不得誤報復原成功', () => {
    expect(isRecoveryPayloadHealthy(true, {
      ok: true,
      alert: true,
      alertLevel: 'critical',
      count: 2096,
    })).toBe(false);
  });

  test('只有非告警且確實產生快照才算復原成功', () => {
    expect(isRecoveryPayloadHealthy(true, {
      ok: true,
      alertLevel: 'none',
      count: 2096,
    })).toBe(true);
    expect(isRecoveryPayloadHealthy(true, { ok: true, skipped: true, count: 2096 })).toBe(false);
    expect(isRecoveryPayloadHealthy(true, { ok: true, count: 0 })).toBe(false);
  });
});
