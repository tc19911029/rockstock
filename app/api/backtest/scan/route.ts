import { NextRequest, NextResponse } from 'next/server';
import { TaiwanScanner } from '@/lib/scanner/TaiwanScanner';
import { ChinaScanner }  from '@/lib/scanner/ChinaScanner';
import { MarketId }      from '@/lib/scanner/types';

export const runtime    = 'nodejs';
export const maxDuration = 120;

/**
 * POST /api/backtest/scan
 * Body: { market: 'TW'|'CN', date: 'YYYY-MM-DD', stocks: [{symbol, name}] }
 *
 * Runs the same rule engine as the live scanner, but fetches data only up to
 * `date` – no future data contamination possible.
 */
export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({})) as {
    market?: string;
    date?:   string;
    stocks?: Array<{ symbol: string; name: string }>;
  };

  const market = (body.market === 'CN' ? 'CN' : 'TW') as MarketId;
  const date   = typeof body.date === 'string' ? body.date : '';
  const stocks = Array.isArray(body.stocks) ? body.stocks : [];

  if (!date || stocks.length === 0) {
    return NextResponse.json({ results: [] });
  }

  // Reject future dates (no real historical data available)
  if (date > new Date().toISOString().split('T')[0]) {
    return NextResponse.json({ error: '不能選未來日期' }, { status: 400 });
  }

  try {
    const scanner = market === 'CN' ? new ChinaScanner() : new TaiwanScanner();
    const { results, marketTrend } = await scanner.scanListAtDate(stocks, date);
    return NextResponse.json({ results, marketTrend });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
