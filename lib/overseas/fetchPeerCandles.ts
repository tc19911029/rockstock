/**
 * 抓單一海外 ticker 日K（海外同業對照用）
 *
 * 2026-06-12 v3（雙源 + 熔斷）：
 * 源 1 Yahoo：Node fetch + session cookie（fc.yahoo.com A3，30 分鐘 cache）+
 *   完整瀏覽器 headers，host 輪替 query2 → query1，curl 備援（自帶本機代理 fallback）。
 *   覆蓋全部市場（美/日/韓/指數），但會 IP 級 429（2026-06-12 實測：直連與代理
 *   出口同鎖、cookie 救不了）→ 模組級熔斷器：撞 429/403 後 10 分鐘內不再打 Yahoo。
 * 源 2 騰訊 usfqkline：只覆蓋美股個股（.OQ/.N）+ TSM ADR + ^IXIC（us.IXIC），
 *   無日韓無 ^SOX；本機連騰訊穩定（陸股管線同源）。qfq 前復權與 Yahoo split-only
 *   在除息日附近有微小差異 — 本管線只算 d1-d60 報酬方向，可接受。
 * 順序：Yahoo（沒熔斷時）→ 騰訊（支援的 ticker）→ 全敗才拋錯；
 *   yahoo-only ticker（日韓/^SOX）在熔斷期間直接拋 YahooRateLimitError（零請求）。
 *
 * 為何不用 stooq / EODHD：stooq 本機直連與代理都不通（2026-06-12 實測）；
 * EODHD token 401 失效（連 2330.TW 都不過，帳號層問題 — 見當日回報）。
 *
 * 量單位：海外股不做張/股換算，存來源原始值（股）。
 * 半根防護由 caller（cron route）用 dropUnsettledTodayBar 處理。
 */

import type { Candle } from '@/types';
import { fetchJsonWithCurlFallback } from '@/lib/datasource/curlFetch';
import { isUSTicker } from '@/lib/utils/symbols';

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

// ── Yahoo 熔斷器（模組級）──────────────────────────────────────────────────
// 撞 429/403 後 10 分鐘內整個 process 不再打 Yahoo — 同一輪 cron 34 檔最多只會
// 對 Yahoo 發 1-2 個請求，避免越打越鎖。
let yahooBlockedUntil = 0;
const YAHOO_BREAKER_MS = 10 * 60_000;

function yahooBlocked(): boolean {
  return Date.now() < yahooBlockedUntil;
}

async function fetchFromYahoo(ticker: string, errors: string[]): Promise<Candle[] | null> {
  const cookie = await getYahooCookie();
  const headers = browserHeaders(cookie);
  let rateLimited = false;

  // 1) Node fetch，host 輪替
  for (const host of ['query2', 'query1'] as const) {
    try {
      const res = await fetch(chartUrl(host, ticker), {
        headers,
        signal: AbortSignal.timeout(15_000),
      });
      if (res.status === 429 || res.status === 403) {
        rateLimited = true;
        errors.push(`yahoo:${host} HTTP ${res.status}`);
        break; // 同 IP 另一 host 大概率同鎖，不多打
      }
      if (!res.ok) {
        errors.push(`yahoo:${host} HTTP ${res.status}`);
        continue;
      }
      const candles = parseChartJson(await res.json() as YahooChartJson);
      if (candles.length > 0) return candles;
      errors.push(`yahoo:${host} empty result`);
    } catch (err) {
      errors.push(`yahoo:${host} ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // 2) curl 備援（自帶本機代理 fallback；已知限流時跳過 — 代理出口大概率同鎖）
  if (!rateLimited) {
    try {
      const { data } = await fetchJsonWithCurlFallback<YahooChartJson>(
        chartUrl('query2', ticker),
        { timeoutMs: 15_000, headers },
      );
      const candles = parseChartJson(data);
      if (candles.length > 0) return candles;
      errors.push('yahoo:curl empty result');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (/429|403/.test(msg)) rateLimited = true;
      errors.push(`yahoo:curl ${msg}`);
    }
  }

  if (rateLimited) {
    yahooBlockedUntil = Date.now() + YAHOO_BREAKER_MS;
    console.warn(`[fetchPeerCandles] Yahoo 限流，熔斷 ${YAHOO_BREAKER_MS / 60_000} 分鐘`);
  }
  return null;
}

// ── 騰訊備源（美股個股 + TSM ADR + ^IXIC）────────────────────────────────────

/** Yahoo ticker → 騰訊 usfqkline 候選代碼；不支援（日韓/^SOX）回空陣列 */
function tencentCandidates(ticker: string): string[] {
  if (ticker === '^IXIC') return ['us.IXIC'];
  if (ticker.startsWith('^')) return []; // ^SOX 騰訊無此指數（2026-06-12 實測 us.SOX 空）
  if (isUSTicker(ticker)) {
    // 交易所後綴未知 → NASDAQ(.OQ) 先試、NYSE(.N) 備援
    return [`us${ticker}.OQ`, `us${ticker}.N`];
  }
  return []; // .T / .KS 騰訊不覆蓋
}

interface TencentKlineJson {
  code?: number;
  data?: Record<string, { qfqday?: string[][]; day?: string[][] }>;
}

/** 騰訊列格式：[date, open, close, high, low, volume?, ...]（注意 close 在 high/low 前）*/
function parseTencentRows(rows: string[][]): Candle[] {
  const out: Candle[] = [];
  for (const row of rows) {
    if (!row || row.length < 5) continue;
    const [date, o, c, h, l, v] = row;
    const open = parseFloat(o); const close = parseFloat(c);
    const high = parseFloat(h); const low = parseFloat(l);
    if (!Number.isFinite(open) || !Number.isFinite(close) || !Number.isFinite(high) || !Number.isFinite(low)) continue;
    out.push({
      date,
      open: +open.toFixed(2),
      high: +high.toFixed(2),
      low: +low.toFixed(2),
      close: +close.toFixed(2),
      volume: v != null && Number.isFinite(parseFloat(v)) ? Math.round(parseFloat(v)) : 0,
    });
  }
  return out;
}

async function fetchFromTencent(ticker: string, errors: string[]): Promise<Candle[] | null> {
  // end 給未來 +2 天：end == 「今天且美股盤中」時騰訊只回今日 1 根半成品
  // （2026-06-12 實測 usTSM.N 盤中 end=當日 → 1 根、end=隔日 → 完整歷史）
  const end = new Date(Date.now() + 2 * 86_400_000).toISOString().split('T')[0];
  const start = new Date(Date.now() - LOOKBACK_DAYS * 86_400_000).toISOString().split('T')[0];
  // 新鮮度門檻：最後一根離今天 >14 天 = 殭屍掛牌（ticker 被重用的舊上市，
  // 如 usDELL.OQ 殘到 2013、usCOHR.OQ 殘到 2023）→ 換下一個候選
  const staleFloor = new Date(Date.now() - 14 * 86_400_000).toISOString().split('T')[0];

  for (const code of tencentCandidates(ticker)) {
    const url =
      `https://web.ifzq.gtimg.cn/appstock/app/usfqkline/get?param=${encodeURIComponent(code)},day,${start},${end},320,qfq`;
    try {
      const { data: json } = await fetchJsonWithCurlFallback<TencentKlineJson>(url, { timeoutMs: 15_000 });
      const entry = json?.data?.[code];
      const rows = entry?.qfqday ?? entry?.day ?? [];
      const candles = parseTencentRows(rows);
      if (candles.length === 0) {
        errors.push(`tencent:${code} empty`);
        continue;
      }
      const lastDate = candles[candles.length - 1].date;
      if (lastDate < staleFloor) {
        errors.push(`tencent:${code} stale (last=${lastDate}, 殭屍掛牌?)`);
        continue;
      }
      if (candles.length < 5) {
        errors.push(`tencent:${code} too few bars (${candles.length})`);
        continue;
      }
      return candles;
    } catch (err) {
      errors.push(`tencent:${code} ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return null;
}

// ── 主入口 ───────────────────────────────────────────────────────────────────

export async function fetchOverseasDailyCandles(ticker: string): Promise<Candle[]> {
  const errors: string[] = [];
  const hasTencent = tencentCandidates(ticker).length > 0;

  // 源 1：Yahoo（熔斷期間跳過，零請求）
  if (!yahooBlocked()) {
    const candles = await fetchFromYahoo(ticker, errors);
    if (candles) return candles;
  } else {
    errors.push('yahoo skipped (circuit breaker)');
  }

  // 源 2：騰訊（支援的 ticker）
  if (hasTencent) {
    const candles = await fetchFromTencent(ticker, errors);
    if (candles) return candles;
  }

  // 全敗：yahoo-only ticker 在限流期間給 route 可辨識的訊號
  if (yahooBlocked() && !hasTencent) {
    throw new YahooRateLimitError(ticker, errors.join('; '));
  }
  throw new Error(`fetch ${ticker} failed: ${errors.join('; ')}`);
}
