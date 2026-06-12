/**
 * 抓單一海外 ticker 日K（海外同業對照用）
 *
 * 主路徑：既有 yahooProvider.getCandlesRange（Node fetch + 快取 + split-only raw OHLC）。
 * 備援：Yahoo 對 Node fetch TLS 指紋偶發封鎖時，走 curlFetch（fetchJsonWithCurlFallback）
 *       直打同一條 v8 chart URL（含本機代理 fallback）。
 *
 * 量單位：海外股不做張/股換算，存 Yahoo 原始值（股）。
 * 半根防護由 caller（cron route）用 dropUnsettledTodayBar 處理。
 */

import type { Candle } from '@/types';
import { yahooProvider } from '@/lib/datasource/YahooDataProvider';
import { fetchJsonWithCurlFallback } from '@/lib/datasource/curlFetch';

/** 自然日 lookback：涵蓋 d60（60 交易日 ≈ 90 自然日）+ 首抓緩衝 */
const LOOKBACK_DAYS = 400;

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

/** 最小 parser（curl 備援路徑用）— 與 YahooDataProvider.parseYahooCandlesRaw 同邏輯（非 TW 不除 1000） */
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

export async function fetchOverseasDailyCandles(ticker: string): Promise<Candle[]> {
  const end = new Date();
  const start = new Date(end.getTime() - LOOKBACK_DAYS * 86_400_000);
  const startStr = start.toISOString().split('T')[0];
  const endStr = end.toISOString().split('T')[0];

  // ── 1) 既有 Yahoo provider ──────────────────────────────────────────────
  let primaryErr: unknown = null;
  try {
    const candles = await yahooProvider.getCandlesRange(ticker, startStr, endStr, 15000);
    if (candles.length > 0) return candles;
    primaryErr = new Error('yahooProvider returned empty');
  } catch (err) {
    primaryErr = err;
  }

  // ── 2) curl 備援（同 URL；Node fetch 被擋時）────────────────────────────
  const startUnix = Math.floor(start.getTime() / 1000);
  const endUnix = Math.floor(end.getTime() / 1000) + 86400;
  const url =
    `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}` +
    `?interval=1d&period1=${startUnix}&period2=${endUnix}&includePrePost=false&events=split`;
  try {
    const { data } = await fetchJsonWithCurlFallback<YahooChartJson>(url, { timeoutMs: 15000 });
    return parseChartJson(data);
  } catch (fallbackErr) {
    const m1 = primaryErr instanceof Error ? primaryErr.message : String(primaryErr);
    const m2 = fallbackErr instanceof Error ? fallbackErr.message : String(fallbackErr);
    throw new Error(`fetch ${ticker} failed: provider (${m1}); curl fallback (${m2})`);
  }
}
