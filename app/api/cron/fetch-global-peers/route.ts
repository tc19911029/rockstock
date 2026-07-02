/**
 * Cron：抓海外同業（peerMap）全部海外 ticker 日K → data/overseas/candles/{ticker}.json
 *
 * 純顯示層（/overseas 對照頁）— 不進任何選股分數 / gate / L1。
 * 逐檔序列抓 + 300ms 間隔（Yahoo 防限流），~34 檔約 30-60 秒。
 * 半根防護：未確定收盤的「今日 bar」不落地（dropUnsettledTodayBar）。
 *
 * 用法：
 *   GET /api/cron/fetch-global-peers                  # 抓 peerMap 全部海外 ticker
 *   GET /api/cron/fetch-global-peers?tickers=MU,285A.T  # 只抓指定（驗證/補抓用）
 */
import { NextRequest } from 'next/server';
import { apiOk, apiError } from '@/lib/api/response';
import { checkCronAuth } from '@/lib/api/cronAuth';
import { getAllOverseasTickers } from '@/lib/scanner/peerMap';
import { fetchOverseasDailyCandles, YahooRateLimitError } from '@/lib/overseas/fetchPeerCandles';
import { dropUnsettledTodayBar } from '@/lib/overseas/peerReturns';
import { writeOverseasCandles } from '@/lib/overseas/peerCandleStorage';

export const runtime = 'nodejs';
export const maxDuration = 300;

// 2026-06-12 v3：原 300ms 間隔實測把 Yahoo 打進 IP 級 429（連代理出口同鎖）。
// 改：1.5s 基礎間隔 + 抖動；Yahoo 限流防護下放到 fetchPeerCandles 的模組級熔斷器
// （整輪最多對 Yahoo 發 1-2 請求），美股/^IXIC 走騰訊備源照常落地，
// 日韓/^SOX（yahoo-only）失敗記錄後隔日 cron 自然補。寫入 merge-by-date，partial 無害。
const FETCH_GAP_MS = 1500;
const FETCH_GAP_JITTER_MS = 700;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

interface TickerResult {
  ticker: string;
  ok: boolean;
  bars?: number;
  lastDate?: string;
  added?: boolean;
  droppedUnsettled?: number;
  error?: string;
}

export async function GET(req: NextRequest) {
  const authDenied = checkCronAuth(req);
  if (authDenied) return authDenied;

  const known = getAllOverseasTickers();
  const tickersParam = req.nextUrl.searchParams.get('tickers');
  let tickers = known;
  if (tickersParam) {
    const requested = tickersParam.split(',').map((t) => t.trim().toUpperCase()).filter(Boolean);
    const knownSet = new Set(known.map((t) => t.toUpperCase()));
    const unknown = requested.filter((t) => !knownSet.has(t));
    if (unknown.length > 0) {
      return apiError(`unknown tickers (not in peerMap): ${unknown.join(', ')}`, 400);
    }
    tickers = requested;
  }

  const results: TickerResult[] = [];
  let yahooRateLimited = false;

  for (let i = 0; i < tickers.length; i++) {
    const ticker = tickers[i];
    try {
      const raw = await fetchOverseasDailyCandles(ticker);
      const settled = dropUnsettledTodayBar(ticker, raw);
      if (settled.length === 0) {
        results.push({ ticker, ok: false, error: 'no settled candles' });
      } else {
        const { added, lastDate, total } = await writeOverseasCandles(ticker, settled);
        results.push({
          ticker, ok: true, bars: total, lastDate, added,
          droppedUnsettled: raw.length - settled.length,
        });
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      results.push({ ticker, ok: false, error: msg });
      if (err instanceof YahooRateLimitError) yahooRateLimited = true;
    }
    if (i < tickers.length - 1) {
      await sleep(FETCH_GAP_MS + Math.floor(Math.random() * FETCH_GAP_JITTER_MS));
    }
  }

  const okCount = results.filter((r) => r.ok).length;
  return apiOk({
    total: tickers.length,
    okCount,
    failCount: tickers.length - okCount,
    ...(yahooRateLimited ? { yahooRateLimited: true } : {}),
    results,
  });
}
