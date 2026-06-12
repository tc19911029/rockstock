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
import { fetchOverseasDailyCandles } from '@/lib/overseas/fetchPeerCandles';
import { dropUnsettledTodayBar } from '@/lib/overseas/peerReturns';
import { writeOverseasCandles } from '@/lib/overseas/peerCandleStorage';

export const runtime = 'nodejs';
export const maxDuration = 300;

const FETCH_GAP_MS = 300;
/** 撞到 Yahoo 429/403 限流時的加長間隔（實測 2026-06-12：直連 403、密集打代理出口會 429） */
const RATE_LIMIT_BACKOFF_MS = 3000;

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
  let gapMs = FETCH_GAP_MS;
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
      gapMs = FETCH_GAP_MS;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      results.push({ ticker, ok: false, error: msg });
      // 撞限流 → 後續放慢，讓剩餘 ticker 還有機會成功
      if (/\b(429|403)\b/.test(msg)) gapMs = RATE_LIMIT_BACKOFF_MS;
    }
    if (i < tickers.length - 1) await sleep(gapMs);
  }

  const okCount = results.filter((r) => r.ok).length;
  return apiOk({
    total: tickers.length,
    okCount,
    failCount: tickers.length - okCount,
    results,
  });
}
