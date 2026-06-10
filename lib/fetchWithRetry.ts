/**
 * Fetch with exponential backoff retry.
 * Retries on network errors and 5xx responses (not 4xx).
 *
 * 每次嘗試都套一個逾時 signal（預設 8s，與呼叫端 signal 合併），確保任何一次 fetch
 * 不會無限卡住整個 retry loop —— 在 fake-IP DNS 下 Node/瀏覽器 fetch 會卡死，
 * 沒有逾時就會讓上層面板（如籌碼面板）的載入骨架永遠不結束。可用 timeout 參數覆寫。
 */
export async function fetchWithRetry(
  input: RequestInfo | URL,
  init?: RequestInit & { maxRetries?: number; baseDelay?: number; timeout?: number },
): Promise<Response> {
  const { maxRetries = 3, baseDelay = 500, timeout = 8000, signal: callerSignal, ...fetchInit } = init ?? {};

  let lastError: unknown;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    // 逾時 signal 與呼叫端 signal 合併（任一觸發即 abort 本次嘗試）
    const signal = callerSignal
      ? AbortSignal.any([callerSignal, AbortSignal.timeout(timeout)])
      : AbortSignal.timeout(timeout);
    try {
      const res = await fetch(input, { ...fetchInit, signal });
      // Don't retry client errors (4xx), only server errors (5xx)
      if (res.ok || (res.status >= 400 && res.status < 500)) return res;
      if (attempt < maxRetries) {
        await sleep(baseDelay * Math.pow(2, attempt));
        continue;
      }
      return res; // Return last failed response
    } catch (err) {
      lastError = err;
      // 呼叫端「主動取消」→ 直接拋、不重試；逾時(我們的 signal)則當可重試的網路錯誤
      if (callerSignal?.aborted) throw err;
      if (attempt < maxRetries) {
        await sleep(baseDelay * Math.pow(2, attempt));
      }
    }
  }
  throw lastError;
}

function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
