export interface VisibilityCandidate {
  symbol: string;
  date: string;
  close: number;
}

export interface VisibilityResult {
  ok: boolean;
  attempts: number;
  error?: string;
}

interface VisibilityOptions {
  secret?: string;
  candidate: VisibilityCandidate;
  baseUrl?: string;
  retries?: number;
  retryDelayMs?: number;
  fetchImpl?: typeof fetch;
}

interface ApiPayload {
  ok?: boolean;
  cleared?: boolean;
  after?: number;
  date?: string;
  close?: number;
}

/**
 * 封存的真正 postcondition：不只確認磁碟寫完，還要確認常駐 API 已清 cache，
 * 並能讀回同一日期與收盤價。任一步失敗都重試，讓 launchd 能把整輪視為失敗再補跑。
 */
export async function ensureServerL1Visibility({
  secret,
  candidate,
  baseUrl = 'http://localhost:3000',
  retries = 3,
  retryDelayMs = 1_000,
  fetchImpl = fetch,
}: VisibilityOptions): Promise<VisibilityResult> {
  if (!secret) return { ok: false, attempts: 0, error: 'CRON_SECRET 未設定' };

  let lastError = 'unknown';
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const clearResponse = await fetchImpl(`${baseUrl}/api/admin/clear-l1-cache`, {
        headers: { Authorization: `Bearer ${secret}` },
        signal: AbortSignal.timeout(10_000),
      });
      const clearPayload = await clearResponse.json() as ApiPayload;
      if (!clearResponse.ok || clearPayload.ok !== true || clearPayload.cleared !== true || clearPayload.after !== 0) {
        throw new Error(`cache clear rejected: HTTP ${clearResponse.status}, after=${clearPayload.after ?? '?'}`);
      }

      const quoteResponse = await fetchImpl(
        `${baseUrl}/api/stock/quote?symbol=${encodeURIComponent(candidate.symbol)}`,
        { signal: AbortSignal.timeout(10_000) },
      );
      const quote = await quoteResponse.json() as ApiPayload;
      const closeMatches = typeof quote.close === 'number'
        && Math.abs(quote.close - candidate.close) <= 0.001;
      if (!quoteResponse.ok || quote.ok !== true || quote.date !== candidate.date || !closeMatches) {
        throw new Error(
          `API still stale: ${candidate.symbol} expected ${candidate.date}/${candidate.close}, `
          + `got ${quote.date ?? '?'}/${quote.close ?? '?'}`,
        );
      }

      return { ok: true, attempts: attempt };
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      if (attempt < retries && retryDelayMs > 0) {
        await new Promise(resolve => setTimeout(resolve, retryDelayMs));
      }
    }
  }

  return { ok: false, attempts: retries, error: lastError };
}
