/**
 * Rate limiter with Upstash Redis (production) and in-memory fallback (dev).
 *
 * Automatically detects Upstash environment variables:
 * - If UPSTASH_REDIS_REST_URL + TOKEN are set → uses Redis (multi-instance safe)
 * - Otherwise → falls back to in-memory sliding window (single-instance only)
 */

import { Ratelimit } from '@upstash/ratelimit';
import { Redis } from '@upstash/redis';

// ── Upstash Redis rate limiters ───────────────────────────────────────────────

const hasUpstash = !!(
  process.env.UPSTASH_REDIS_REST_URL &&
  process.env.UPSTASH_REDIS_REST_TOKEN
);

function createUpstashLimiter(
  prefix: string,
  maxRequests: number,
  windowSec: number,
) {
  return new Ratelimit({
    redis: Redis.fromEnv(),
    limiter: Ratelimit.slidingWindow(maxRequests, `${windowSec} s`),
    prefix: `ratelimit:${prefix}`,
    analytics: true,
  });
}

// ── In-memory fallback (same as before, for local dev) ────────────────────────

interface RateLimitEntry {
  tokens: number;
  lastRefill: number;
}

function createMemoryLimiter(maxRequests: number, windowMs: number) {
  const store = new Map<string, RateLimitEntry>();
  let lastCleanup = Date.now();

  return {
    async check(identifier: string): Promise<{
      success: boolean;
      remaining: number;
      retryAfter?: number;
    }> {
      const now = Date.now();

      // Periodic cleanup
      if (now - lastCleanup > 60_000) {
        lastCleanup = now;
        for (const [key, entry] of store) {
          if (now - entry.lastRefill > windowMs * 2) store.delete(key);
        }
      }

      const entry = store.get(identifier);
      if (!entry) {
        store.set(identifier, { tokens: maxRequests - 1, lastRefill: now });
        return { success: true, remaining: maxRequests - 1 };
      }

      const elapsed = now - entry.lastRefill;
      const refillRate = maxRequests / windowMs;
      entry.tokens = Math.min(maxRequests, entry.tokens + elapsed * refillRate);
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

// ── Unified interface ─────────────────────────────────────────────────────────

interface RateLimitResult {
  success: boolean;
  remaining: number;
  retryAfter?: number;
}

interface RateLimiter {
  check: (identifier: string) => Promise<RateLimitResult>;
}

function createLimiter(
  name: string,
  maxRequests: number,
  windowSec: number,
): RateLimiter {
  if (hasUpstash) {
    const rl = createUpstashLimiter(name, maxRequests, windowSec);
    return {
      async check(identifier: string): Promise<RateLimitResult> {
        const result = await rl.limit(identifier);
        return {
          success: result.success,
          remaining: result.remaining,
          retryAfter: result.success ? undefined : result.reset - Date.now(),
        };
      },
    };
  }

  return createMemoryLimiter(maxRequests, windowSec * 1000);
}

// ── Pre-configured limiters ──────────────────────────────────────────────────

/** General API: 60 requests per 60 seconds */
export const generalLimiter = createLimiter('general', 60, 60);

/** AI/expensive endpoints: 10 requests per 60 seconds */
export const aiLimiter = createLimiter('ai', 10, 60);

/** Scanner endpoints: 5 requests per 60 seconds */
export const scanLimiter = createLimiter('scan', 5, 60);

/** Whether Upstash Redis is configured */
export const isUpstashEnabled = hasUpstash;
