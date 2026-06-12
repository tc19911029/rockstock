/**
 * 抓單一海外 ticker 日K（海外同業對照用）
 *
 * 2026-06-12 v2（429 風暴後重寫）：
 * 主路徑：Node fetch + Yahoo session cookie（fc.yahoo.com A3，30 分鐘 cache）+
 *         完整瀏覽器 headers，host 輪替 query2 → query1（兩 host 限流池不完全同步）。
 * 備援：curlFetch（同組 headers，自帶本機代理 fallback）。
 * 設計原則：被限流時「少打」— 一檔最多 3 個請求；429/403 拋 YahooRateLimitError
 * 讓 cron route 拉長退避或提早收工，避免越打越鎖（2026-06-12 實測：密集測試
 * 觸發 IP 級 429，直連與代理出口同鎖，cookie 也救不了，只能等冷卻）。
 *
 * 量單位：海外股不做張/股換算，存 Yahoo 原始值（股）。
 * 半根防護由 caller（cron route）用 dropUnsettledTodayBar 處理。
 */

import type { Candle } from '@/types';
import { fetchJsonWithCurlFallback } from '@/lib/datasource/curlFetch';

/** 自然日 lookback：涵蓋 d60（60 交易日 ≈ 90 自然日）+ 首抓緩衝 */
const LOOKBACK_DAYS = 400;

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

/** Yahoo 對本 IP 限流（429/403）— route 據此拉長退避或提早收工 */
export class YahooRateLimitError extends Error {
  constructor(ticker: string, detail: string) {
    super(`Yahoo rate-limited for ${ticker}: ${detail}`);
    this.name = 'YahooRateLimitError';
  }
}

// ── Yahoo session cookie（fc.yahoo.com 回 404 但帶 A3 cookie）──────────────────
let sessionCache: { cookie: string; at: number } | null = null;
const SESSION_TTL = 30 * 60_000;

async function getYahooCookie(): Promise<string | null> {
  if (sessionCache && Date.now() - sessionCache.at < SESSION_TTL) return sessionCache.cookie;
  try {
    const res = await fetch('https://fc.yahoo.com', {
      headers: { 'User-Agent': UA },
      signal: AbortSignal.timeout(10_000),
    });
    // node fetch 會把多個 set-cookie 併成一條，regex 撈 A3 即可
    const setCookie = res.headers.get('set-cookie') ?? '';
    const m = setCookie.match(/A3=[^;]+/);
    if (m) {
      sessionCache = { cookie: m[0], at: Date.now() };
      return m[0];
    }
  } catch { /* session 拿不到就裸打（headers 仍是瀏覽器形）*/ }
  return null;
}

function browserHeaders(cookie: string | null): Record<string, string> {
  return {
    'User-Agent': UA,
    'Accept': 'application/json, text/plain, */*',
    'Accept-Language': 'en-US,en;q=0.9,zh-TW;q=0.8',
    'Referer': 'https://finance.yahoo.com/',
    ...(cookie ? { 'Cookie': cookie } : {}),
  };
}

interface YahooChartJson {
  chart?: {
    result?: Array<{
      timestamp?: number[];
      indicators?: {
        quote?: Array<{
          open: (number | null)[];
          high: (number | null)[];
          low: (number | null)[];
          close: (number | null)[];
          volume: (number | null)[];
        }>;
      };
    }>;
    error?: unknown;
  };
}

/** 最小 parser — 與 YahooDataProvider.parseYahooCandlesRaw 同邏輯（非 TW 不除 1000） */
function parseChartJson(json: YahooChartJson): Candle[] {
  const result = json?.chart?.result?.[0];
  if (!result) return [];
  const timestamps = result.timestamp ?? [];
  const q = result.indicators?.quote?.[0];
  if (!q) return [];
  const out: Candle[] = [];
  for (let i = 0; i < timestamps.length; i++) {
    const o = q.open[i]; const h = q.high[i];
    const l = q.low[i];  const c = q.close[i];
    if (o == null || h == null || l == null || c == null || Number.isNaN(o)) continue;
    out.push({
      date: new Date(timestamps[i] * 1000).toISOString().split('T')[0],
      open: +o.toFixed(2),
      high: +h.toFixed(2),
      low: +l.toFixed(2),
      close: +c.toFixed(2),
      volume: q.volume[i] != null ? Math.round(q.volume[i]!) : 0,
    });
  }
  return out;
}

function chartUrl(host: 'query2' | 'query1', ticker: string): string {
  const end = new Date();
  const start = new Date(end.getTime() - LOOKBACK_DAYS * 86_400_000);
  const startUnix = Math.floor(start.getTime() / 1000);
  const endUnix = Math.floor(end.getTime() / 1000) + 86400;
  return (
    `https://${host}.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}` +
    `?interval=1d&period1=${startUnix}&period2=${endUnix}&includePrePost=false&events=split`
  );
}

export async function fetchOverseasDailyCandles(ticker: string): Promise<Candle[]> {
  const cookie = await getYahooCookie();
  const headers = browserHeaders(cookie);
  const errors: string[] = [];
  let rateLimited = false;

  // ── 1) Node fetch，host 輪替 ────────────────────────────────────────────
  for (const host of ['query2', 'query1'] as const) {
    try {
      const res = await fetch(chartUrl(host, ticker), {
        headers,
        signal: AbortSignal.timeout(15_000),
      });
      if (res.status === 429 || res.status === 403) {
        rateLimited = true;
        errors.push(`${host} HTTP ${res.status}`);
        continue;
      }
      if (!res.ok) {
        errors.push(`${host} HTTP ${res.status}`);
        continue;
      }
      const candles = parseChartJson(await res.json() as YahooChartJson);
      if (candles.length > 0) return candles;
      errors.push(`${host} empty result`);
    } catch (err) {
      errors.push(`${host} ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // ── 2) curl 備援（自帶本機代理 fallback；同組瀏覽器 headers）────────────
  // 已知限流（兩 host 都 429）時跳過 — 代理出口大概率同鎖，多打只會延長封鎖
  if (!rateLimited) {
    try {
      const { data } = await fetchJsonWithCurlFallback<YahooChartJson>(
        chartUrl('query2', ticker),
        { timeoutMs: 15_000, headers },
      );
      const candles = parseChartJson(data);
      if (candles.length > 0) return candles;
      errors.push('curl empty result');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (/429|403/.test(msg)) rateLimited = true;
      errors.push(`curl ${msg}`);
    }
  }

  if (rateLimited) throw new YahooRateLimitError(ticker, errors.join('; '));
  throw new Error(`fetch ${ticker} failed: ${errors.join('; ')}`);
}
