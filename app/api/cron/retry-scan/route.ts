/**
 * L4 掃描重試 — 若今日掃描結果為空則自動重跑
 *
 * GET /api/cron/retry-scan?market=TW
 * GET /api/cron/retry-scan?market=CN
 *
 * 邏輯：
 * 1. 讀 L4 今日 long-daily session
 * 2. resultCount > 0 → 跳過（已有結果）
 * 3. resultCount = 0 或不存在 → 重跑完整掃描（long daily + MTF + short daily + short MTF）
 *
 * 排程：
 *   TW: 30 6 * * 1-5（14:30 CST，scan-tw 後 30 分鐘）
 *   CN: 15 8 * * 1-5（16:15 CST，scan-cn 後 30 分鐘）
 */

import { NextRequest } from 'next/server';
import { apiOk, apiError } from '@/lib/api/response';
import { loadScanSession, saveScanSession } from '@/lib/storage/scanStorage';
import { ScanSession } from '@/lib/scanner/types';
import { ZHU_V1 } from '@/lib/strategy/StrategyConfig';
import { isTradingDay } from '@/lib/utils/tradingDay';
import { getLastTradingDay } from '@/lib/datasource/marketHours';
import { TaiwanScanner } from '@/lib/scanner/TaiwanScanner';
import { ChinaScanner } from '@/lib/scanner/ChinaScanner';

export const runtime = 'nodejs';
export const maxDuration = 300;

type MarketType = 'TW' | 'CN';

/** 注入 L2 即時報價到 scanner */
async function injectL2(scanner: TaiwanScanner | ChinaScanner, market: MarketType, date: string) {
  try {
    const { readIntradaySnapshot } = await import('@/lib/datasource/IntradayCache');
    const snap = await readIntradaySnapshot(market, date);
    if (!snap || snap.quotes.length === 0) return 0;

    const realtimeQuotes = new Map<string, { open: number; high: number; low: number; close: number; volume: number; date?: string }>();
    const suffix = market === 'TW' ? /\.(TW|TWO)$/i : /\.(SS|SZ)$/i;
    for (const q of snap.quotes) {
      if (q.close > 0) {
        realtimeQuotes.set(q.symbol.replace(suffix, ''), {
          open: q.open, high: q.high, low: q.low,
          close: q.close, volume: q.volume, date: snap.date,
        });
      }
    }
    if (realtimeQuotes.size > 0) scanner.setRealtimeQuotes(realtimeQuotes);
    return realtimeQuotes.size;
  } catch {
    return 0;
  }
}

export async function GET(req: NextRequest) {
  const authHeader = req.headers.get('authorization');
  if (process.env.CRON_SECRET && authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return apiError('Unauthorized', 401);
  }

  const market = req.nextUrl.searchParams.get('market') as MarketType | null;
  if (market !== 'TW' && market !== 'CN') {
    return apiError('market must be TW or CN', 400);
  }

  const date = getLastTradingDay(market);

  if (!isTradingDay(date, market)) {
    return apiOk({ skipped: true, reason: 'non-trading day', date });
  }

  // ── 檢查 L4 是否已有結果 ────────────────────────────────────────────────────
  const existing = await loadScanSession(market, date, 'long', 'daily');
  if (existing && existing.resultCount > 0) {
    return apiOk({
      skipped: true,
      reason: 'scan already has results',
      date,
      resultCount: existing.resultCount,
    });
  }

  console.warn(`[retry-scan] ${market} ${date} long-daily resultCount=${existing?.resultCount ?? 'missing'}, 重新掃描`);

  // ── 重新掃描 ─────────────────────────────────────────────────────────────────
  const scanner = market === 'TW' ? new TaiwanScanner() : new ChinaScanner();
  const l2Count = await injectL2(scanner, market, date);
  console.info(`[retry-scan] ${market} L2 注入 ${l2Count} 支`);

  const stocks = await scanner.getStockList();
  const counts: Record<string, number> = {};
  const prefix = market;

  // Long daily
  try {
    const { results, sessionFreshness } = await scanner.scanSOP(stocks, date);
    const session: ScanSession = {
      id: `${prefix}-long-daily-retry-${date}-${Date.now()}`,
      market, date, direction: 'long',
      multiTimeframeEnabled: false,
      sessionType: 'post_close',
      scanTime: new Date().toISOString(),
      resultCount: results.length, results,
      dataFreshness: sessionFreshness,
    };
    await saveScanSession(session, { allowOverwritePostClose: true });
    counts.longDaily = results.length;
  } catch (err) {
    console.error('[retry-scan] long-daily 失敗:', err);
    counts.longDaily = 0;
  }

  // Long MTF
  try {
    const { results, sessionFreshness } = await scanner.scanSOP(stocks, date, { ...ZHU_V1.thresholds, multiTimeframeFilter: true });
    const session: ScanSession = {
      id: `${prefix}-long-mtf-retry-${date}-${Date.now()}`,
      market, date, direction: 'long',
      multiTimeframeEnabled: true,
      sessionType: 'post_close',
      scanTime: new Date().toISOString(),
      resultCount: results.length, results,
      dataFreshness: sessionFreshness,
    };
    await saveScanSession(session, { allowOverwritePostClose: true });
    counts.longMtf = results.length;
  } catch { counts.longMtf = 0; }

  // Short daily
  try {
    const { candidates, sessionFreshness } = await scanner.scanShortCandidates(stocks, date);
    const session: ScanSession = {
      id: `${prefix}-short-daily-retry-${date}-${Date.now()}`,
      market, date, direction: 'short',
      multiTimeframeEnabled: false,
      sessionType: 'post_close',
      scanTime: new Date().toISOString(),
      resultCount: candidates.length, results: candidates,
      dataFreshness: sessionFreshness,
    };
    await saveScanSession(session, { allowOverwritePostClose: true });
    counts.shortDaily = candidates.length;
  } catch { counts.shortDaily = 0; }

  // Short MTF
  try {
    const { candidates, sessionFreshness } = await scanner.scanShortCandidates(stocks, date, { ...ZHU_V1.thresholds, multiTimeframeFilter: true });
    const session: ScanSession = {
      id: `${prefix}-short-mtf-retry-${date}-${Date.now()}`,
      market, date, direction: 'short',
      multiTimeframeEnabled: true,
      sessionType: 'post_close',
      scanTime: new Date().toISOString(),
      resultCount: candidates.length, results: candidates,
      dataFreshness: sessionFreshness,
    };
    await saveScanSession(session, { allowOverwritePostClose: true });
    counts.shortMtf = candidates.length;
  } catch { counts.shortMtf = 0; }

  return apiOk({ retried: true, date, counts });
}
