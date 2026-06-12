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

// 2026-06-12 v2：原 300ms 間隔 + 3s 退避實測會把 Yahoo 打進 IP 級 429（連代理出口同鎖）。
// 改：1.5s 基礎間隔 + 抖動；撞限流先長退避 60s 重試同一檔一次；再撞 → 提早收工
// （剩餘標 skipped，寧可隔日 cron 補也不要延長封鎖）。寫入 merge-by-date，partial 無害。
const FETCH_GAP_MS = 1500;
const FETCH_GAP_JITTER_MS = 700;
const RATE_LIMIT_BACKOFF_MS = 60_000;

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
  let rateLimitedAbort = false;
  let backoffUsed = false;

  const fetchOne = async (ticker: string): Promise<void> => {
    const raw = await fetchOverseasDailyCandles(ticker);
    const settled = dropUnsettledTodayBar(ticker, raw);
    if (settled.length === 0) {
      results.push({ ticker, ok: false, error: 'no settled candles' });
      return;
    }
    const { added, lastDate, total } = await writeOverseasCandles(ticker, settled);
    results.push({
      ticker, ok: true, bars: total, lastDate, added,
      droppedUnsettled: raw.length - settled.length,
    });
  };

  for (let i = 0; i < tickers.length; i++) {
    const ticker = tickers[i];
    try {
      await fetchOne(ticker);
    } catch (err) {
      if (err instanceof YahooRateLimitError && !backoffUsed) {
        // 第一次撞限流：長退避後重試同一檔一次
        backoffUsed = true;
        console.warn(`[fetch-global-peers] ${ticker} 撞限流，退避 ${RATE_LIMIT_BACKOFF_MS / 1000}s 後重試`);
        await sleep(RATE_LIMIT_BACKOFF_MS);
        try {
          await fetchOne(ticker);
        } catch (retryErr) {
          const msg = retryErr instanceof Error ? retryErr.message : String(retryErr);
          results.push({ ticker, ok: false, error: msg });
          if (retryErr instanceof YahooRateLimitError) {
            // 退避後仍限流 → 提早收工，剩餘標 skipped（隔日 cron 自然補）
            rateLimitedAbort = true;
            for (const rest of tickers.slice(i + 1)) {
              results.push({ ticker: rest, ok: false, error: 'skipped (rate-limited abort)' });
            }
            break;
          }
        }
      } else {
        const msg = err instanceof Error ? err.message : String(err);
        results.push({ ticker, ok: false, error: msg });
        if (err instanceof YahooRateLimitError) {
          rateLimitedAbort = true;
          for (const rest of tickers.slice(i + 1)) {
            results.push({ ticker: rest, ok: false, error: 'skipped (rate-limited abort)' });
          }
          break;
        }
      }
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
    ...(rateLimitedAbort ? { rateLimitedAbort: true } : {}),
    results,
  });
}
