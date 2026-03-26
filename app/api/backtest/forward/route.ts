import { NextRequest, NextResponse } from 'next/server';
import { analyzeForwardBatch } from '@/lib/backtest/ForwardAnalyzer';

export const runtime    = 'nodejs';
export const maxDuration = 60;

/**
 * POST /api/backtest/forward
 * Body: {
 *   scanDate: 'YYYY-MM-DD',
 *   stocks: [{ symbol: string; name: string; scanPrice: number }]
 * }
 *
 * Returns forward performance data for each stock after the scan date.
 * Safe to call even if scan date is recent (returns partial data).
 */
export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({})) as {
    scanDate?: string;
    stocks?:   Array<{ symbol: string; name: string; scanPrice: number }>;
  };

  const scanDate = typeof body.scanDate === 'string' ? body.scanDate : '';
  const stocks   = Array.isArray(body.stocks) ? body.stocks : [];

  if (!scanDate || stocks.length === 0) {
    return NextResponse.json({ performance: [] });
  }

  try {
    const performance = await analyzeForwardBatch(stocks, scanDate);
    return NextResponse.json({ performance });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
