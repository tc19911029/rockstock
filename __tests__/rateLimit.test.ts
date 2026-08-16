import {
  aiLimiter,
  checkApiRateLimit,
  forwardLimiter,
  generalLimiter,
  READ_RATE_LIMIT_MAX,
  readLimiter,
  scanLimiter,
} from '../lib/rateLimit';

// ── Pre-configured limiters (async interface) ─────────────────────────────────

describe('pre-configured limiters', () => {
  test('generalLimiter allows requests', async () => {
    const result = await generalLimiter.check('general-test-ip-' + Date.now());
    expect(result.success).toBe(true);
    expect(result.remaining).toBeLessThanOrEqual(59);
  });

  test('aiLimiter allows requests', async () => {
    const result = await aiLimiter.check('ai-test-ip-' + Date.now());
    expect(result.success).toBe(true);
    expect(result.remaining).toBeLessThanOrEqual(9);
  });

  test('scanLimiter allows requests', async () => {
    const result = await scanLimiter.check('scan-test-ip-' + Date.now());
    expect(result.success).toBe(true);
    expect(result.remaining).toBeLessThanOrEqual(4);
  });

  test('forwardLimiter allows requests', async () => {
    const result = await forwardLimiter.check('forward-test-ip-' + Date.now());
    expect(result.success).toBe(true);
    expect(result.remaining).toBeLessThanOrEqual(29);
  });

  test('readLimiter allows multi-panel and multi-tab dashboard bursts, then still limits', () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-08-16T06:00:00.000Z'));
    const identifier = `read-burst-${Date.now()}`;
    for (let request = 0; request < READ_RATE_LIMIT_MAX; request += 1) {
      expect(checkApiRateLimit('/api/market-data', identifier, 'GET').success).toBe(true);
    }
    expect(checkApiRateLimit('/api/market-data', identifier, 'GET').success).toBe(false);
    expect(readLimiter.check(`${identifier}-direct`).remaining).toBe(READ_RATE_LIMIT_MAX - 1);
    jest.useRealTimers();
  });

  test('forward-performance requests are isolated from the general API bucket', () => {
    const identifier = `forward-isolation-${Date.now()}`;

    for (let request = 0; request < 60; request += 1) {
      expect(checkApiRateLimit('/api/health', identifier, 'POST').success).toBe(true);
    }
    expect(checkApiRateLimit('/api/health', identifier, 'POST').success).toBe(false);

    const forwardResult = checkApiRateLimit('/api/backtest/forward', identifier);
    expect(forwardResult.success).toBe(true);
    expect(forwardResult.remaining).toBe(29);
  });

  test('read and write requests use isolated buckets', () => {
    const identifier = `method-isolation-${Date.now()}`;
    for (let request = 0; request < 60; request += 1) {
      expect(checkApiRateLimit('/api/agents/portfolio', identifier, 'POST').success).toBe(true);
    }
    expect(checkApiRateLimit('/api/agents/portfolio', identifier, 'POST').success).toBe(false);
    expect(checkApiRateLimit('/api/agents/portfolio', identifier, 'GET').success).toBe(true);
  });

  test('forward-performance requests retain their own rate limit', () => {
    const identifier = `forward-limit-${Date.now()}`;

    for (let request = 0; request < 30; request += 1) {
      expect(checkApiRateLimit('/api/backtest/forward', identifier).success).toBe(true);
    }
    expect(checkApiRateLimit('/api/backtest/forward', identifier).success).toBe(false);
  });
});
