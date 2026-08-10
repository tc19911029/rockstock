import {
  aiLimiter,
  checkApiRateLimit,
  forwardLimiter,
  generalLimiter,
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

  test('forward-performance requests are isolated from the general API bucket', () => {
    const identifier = `forward-isolation-${Date.now()}`;

    for (let request = 0; request < 60; request += 1) {
      expect(checkApiRateLimit('/api/health', identifier).success).toBe(true);
    }
    expect(checkApiRateLimit('/api/health', identifier).success).toBe(false);

    const forwardResult = checkApiRateLimit('/api/backtest/forward', identifier);
    expect(forwardResult.success).toBe(true);
    expect(forwardResult.remaining).toBe(29);
  });

  test('forward-performance requests retain their own rate limit', () => {
    const identifier = `forward-limit-${Date.now()}`;

    for (let request = 0; request < 30; request += 1) {
      expect(checkApiRateLimit('/api/backtest/forward', identifier).success).toBe(true);
    }
    expect(checkApiRateLimit('/api/backtest/forward', identifier).success).toBe(false);
  });
});
