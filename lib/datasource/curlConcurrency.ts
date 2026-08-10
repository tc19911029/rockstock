/**
 * Process-wide concurrency guard for curl fallback subprocesses.
 *
 * Several cron/API routes share curlFetch and may overlap. Limiting each caller
 * separately is not enough: the combined child-process count can still exhaust
 * the host. Keep the limiter on globalThis so separately bundled Next.js route
 * modules in the same server process share one queue.
 */

export interface AsyncConcurrencyLimiter {
  run<T>(task: () => Promise<T>): Promise<T>;
}

export function createConcurrencyLimiter(maxConcurrency: number): AsyncConcurrencyLimiter {
  if (!Number.isInteger(maxConcurrency) || maxConcurrency < 1) {
    throw new Error(`maxConcurrency must be a positive integer, received ${maxConcurrency}`);
  }

  let active = 0;
  const queue: Array<() => void> = [];

  const acquire = async (): Promise<void> => {
    if (active < maxConcurrency) {
      active += 1;
      return;
    }

    await new Promise<void>((resolve) => queue.push(resolve));
    active += 1;
  };

  const release = (): void => {
    active -= 1;
    queue.shift()?.();
  };

  return {
    async run<T>(task: () => Promise<T>): Promise<T> {
      await acquire();
      try {
        return await task();
      } finally {
        release();
      }
    },
  };
}

const configuredLimit = Number.parseInt(process.env.ROCKSTOCK_MAX_CURL_CONCURRENCY ?? '8', 10);
export const MAX_CURL_CONCURRENCY = Number.isInteger(configuredLimit) && configuredLimit > 0
  ? Math.min(configuredLimit, 32)
  : 8;

type CurlLimiterGlobal = typeof globalThis & {
  __rockstockCurlConcurrencyLimiter?: AsyncConcurrencyLimiter;
};

const curlLimiterGlobal = globalThis as CurlLimiterGlobal;
const processWideLimiter = curlLimiterGlobal.__rockstockCurlConcurrencyLimiter
  ?? createConcurrencyLimiter(MAX_CURL_CONCURRENCY);
curlLimiterGlobal.__rockstockCurlConcurrencyLimiter = processWideLimiter;

export function runWithCurlConcurrencyLimit<T>(task: () => Promise<T>): Promise<T> {
  return processWideLimiter.run(task);
}
