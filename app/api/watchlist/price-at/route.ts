import { NextRequest, NextResponse } from 'next/server';
import { loadLocalCandlesForDate } from '@/lib/datasource/LocalCandleStore';

/**
 * GET /api/watchlist/price-at?symbol=603986.SS&date=2026-04-01
 * 回傳指定日期（或最近交易日）的收盤價，供自選股「加入至今漲幅」使用。
 * 僅讀 L1 本地快取，不打外部 API，快速輕量。
 */
export async function GET(req: NextRequest) {
  const symbol = req.nextUrl.searchParams.get('symbol') ?? '';
  const date = req.nextUrl.searchParams.get('date') ?? '';

  if (!symbol || !date) {
    return NextResponse.json({ error: 'symbol 和 date 為必填' }, { status: 400 });
  }

  const market: 'TW' | 'CN' = /\.(SS|SZ)$/i.test(symbol) ? 'CN' : 'TW';

  try {
    // 讀本地 K 線至 date 當日
    const candles = await loadLocalCandlesForDate(symbol, market, date);
    if (candles && candles.length > 0) {
      const last = candles[candles.length - 1];
      return NextResponse.json({ price: last.close, date: last.date });
    }

    // L1 無資料時，往前找最多 10 個交易日的資料
    const { loadLocalCandlesWithTolerance } = await import('@/lib/datasource/LocalCandleStore');
    const result = await loadLocalCandlesWithTolerance(symbol, market, date, 10);
    if (result && result.candles.length > 0) {
      const last = result.candles[result.candles.length - 1];
      return NextResponse.json({ price: last.close, date: last.date });
    }

    return NextResponse.json({ error: '本地無此股票資料' }, { status: 404 });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
