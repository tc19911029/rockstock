/**
 * Simple in-memory rate limiter for API routes.
 *
 * Uses a sliding window approach per IP address.
 * Suitable for single-instance deployments (Vercel serverless).
 * For multi-instance, consider @upstash/ratelimit with Redis.
 */

interface RateLimitEntry {
  tokens: number;
  lastRefill: number;
}

interface RateLimitConfig {
  /** Maximum requests allowed in the window */
  maxRequests: number;
  /** Window size in milliseconds */
  windowMs: number;
}

const stores = new Map<string, Map<string, RateLimitEntry>>();

/**
 * Create a rate limiter with the given config.
 * Returns a function that checks if a request should be allowed.
 */
export function createRateLimit(name: string, config: RateLimitConfig) {
  if (!stores.has(name)) {
    stores.set(name, new Map());
  }
  const store = stores.get(name)!;

  // Periodic cleanup of expired entries (every 60s)
  let lastCleanup = Date.now();
  const CLEANUP_INTERVAL = 60_000;

  return {
    /**
     * Check if the request from the given identifier should be allowed.
     * @returns { success: true } if allowed, { success: false, retryAfter } if rate limited
     */
    check(identifier: string): { success: boolean; remaining: number; retryAfter?: number } {
      const now = Date.now();

      // Periodic cleanup
      if (now - lastCleanup > CLEANUP_INTERVAL) {
        lastCleanup = now;
        for (const [key, entry] of store) {
          if (now - entry.lastRefill > config.windowMs * 2) {
            store.delete(key);
          }
        }
      }

      const entry = store.get(identifier);

      if (!entry) {
        store.set(identifier, { tokens: config.maxRequests - 1, lastRefill: now });
        return { success: true, remaining: config.maxRequests - 1 };
      }

      // Refill tokens based on elapsed time
      const elapsed = now - entry.lastRefill;
      const refillRate = config.maxRequests / config.windowMs;
      const tokensToAdd = elapsed * refillRate;
      entry.tokens = Math.min(config.maxRequests, entry.tokens + tokensToAdd);
      entry.lastRefill = now;

      if (entry.tokens < 1) {
        const retryAfter = Math.ceil((1 - entry.tokens) / refillRate);
        return { success: false, remaining: 0, retryAfter };
      }

      entry.tokens -= 1;
      return { success: true, remaining: Math.floor(entry.tokens) };
    },
  };
}

// ── Pre-configured limiters ──────────────────────────────────────────────────

/** General API: 60 requests per minute */
export const generalLimiter = createRateLimit('general', {
  maxRequests: 60,
  windowMs: 60_000,
});

/**
 * Read-only API: dashboard 初次載入與切換股票會並行讀取多個面板。
 * 與寫入操作分桶，避免正常巡覽耗盡 general bucket、連持倉 hydration 都被 429。
 */
export const readLimiter = createRateLimit('read', {
  maxRequests: 240,
  windowMs: 60_000,
});

/** AI/expensive endpoints: 10 requests per minute */
export const aiLimiter = createRateLimit('ai', {
  maxRequests: 10,
  windowMs: 60_000,
});

/** Scanner endpoints: 5 requests per minute */
export const scanLimiter = createRateLimit('scan', {
  maxRequests: 5,
  windowMs: 60_000,
});

/** Forward-performance analysis: isolated from homepage API bursts. */
export const forwardLimiter = createRateLimit('forward', {
  maxRequests: 30,
  windowMs: 60_000,
});

/** Routes that use AI (expensive). */
const AI_ROUTES = [
  '/api/chat',
  '/api/scanner/ai-rank',
  '/api/coach/chart-digest',
  '/api/coach/codex-followup',
];

/** Routes that trigger scans (heavy compute). */
const SCAN_ROUTES = ['/api/scanner/run', '/api/scanner/chunk', '/api/backtest/scan'];

/** Routes that calculate follow-up performance. */
const FORWARD_ROUTES = ['/api/backtest/forward'];

/**
 * Apply the limiter assigned to an API route.
 * Keeping this selection here makes bucket isolation explicit and testable.
 */
export function checkApiRateLimit(pathname: string, identifier: string, method = 'GET') {
  if (AI_ROUTES.some(route => pathname.startsWith(route))) {
    return aiLimiter.check(identifier);
  }

  if (SCAN_ROUTES.some(route => pathname.startsWith(route))) {
    return scanLimiter.check(identifier);
  }

  if (FORWARD_ROUTES.some(route => pathname.startsWith(route))) {
    return forwardLimiter.check(identifier);
  }

  if (method === 'GET' || method === 'HEAD') {
    return readLimiter.check(identifier);
  }

  return generalLimiter.check(identifier);
}
