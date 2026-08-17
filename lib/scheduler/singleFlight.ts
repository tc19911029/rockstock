export type SingleFlightRunner = <T>(key: string, task: () => Promise<T>) => Promise<T>;

/**
 * 相同 key 同時間只執行一份工作；後到的 caller 共用既有 Promise。
 * 工作成功或失敗後都會清除，讓下一輪可以正常重試。
 */
export function createSingleFlightRunner(onJoin?: (key: string) => void): SingleFlightRunner {
  const inflight = new Map<string, Promise<unknown>>();

  return async function run<T>(key: string, task: () => Promise<T>): Promise<T> {
    const existing = inflight.get(key) as Promise<T> | undefined;
    if (existing) {
      onJoin?.(key);
      return existing;
    }

    const promise = task();
    inflight.set(key, promise);
    try {
      return await promise;
    } finally {
      if (inflight.get(key) === promise) inflight.delete(key);
    }
  };
}
