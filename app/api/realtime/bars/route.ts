/**
 * GET /api/realtime/bars?symbol=3661.TW&tf=1m
 *
 * UI 用：讀 minuteBarStore 內某 symbol 的 bars + 最近警示
 *   tf = '1m' | '5m' | '15m'（5m/15m 從 1m 即時聚合）
 *
 * 若 buffer 為空且當下盤中 → 自動跑一次 backfillFromVendor 補當日歷史
 */

import { NextRequest } from 'next/server';
import { apiOk, apiError } from '@/lib/api/response';
import {
  getBars, aggregateBars, ensureSymbol, backfillFromVendor,
} from '@/lib/realtime/minuteBarStore';
import { listRecentAlerts } from '@/lib/realtime/alertDispatcher';

export const runtime = 'nodejs';

export async function GET(req: NextRequest) {
  const symbol = req.nextUrl.searchParams.get('symbol');
  const tfParam = req.nextUrl.searchParams.get('tf') ?? '1m';
  if (!symbol) return apiError('symbol required', 400);

  const market = inferMarket(symbol);
  ensureSymbol(symbol, market);

  let bars1m = getBars(symbol);
  if (bars1m.length === 0) {
    // lazy backfill — 沒 bar 就先補一次
    await backfillFromVendor(symbol, market).catch(() => null);
    bars1m = getBars(symbol);
  }

  const tfMin: 1 | 5 | 15 =
    tfParam === '5m' ? 5
    : tfParam === '15m' ? 15
    : 1;
  const bars = aggregateBars(bars1m, tfMin);

  const allAlerts = await listRecentAlerts(100);
  const symbolAlerts = allAlerts.filter(a => a.symbol === symbol).slice(0, 20);

  return apiOk({
    symbol,
    market,
    tf: `${tfMin}m`,
    barCount: bars.length,
    bars,
    alerts: symbolAlerts,
  });
}

function inferMarket(symbol: string): 'TW' | 'CN' {
  if (/\.(TW|TWO)$/i.test(symbol)) return 'TW';
  if (/\.(SS|SZ)$/i.test(symbol)) return 'CN';
  return 'TW';
}
