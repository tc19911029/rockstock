import { generalLimiter, aiLimiter, scanLimiter } from '../lib/rateLimit';

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
});
