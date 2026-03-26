import { NextRequest, NextResponse } from 'next/server';

export const runtime = 'nodejs';
export const maxDuration = 120; // one chunk takes ~80s max

import { TaiwanScanner } from '@/lib/scanner/TaiwanScanner';
import { ChinaScanner } from '@/lib/scanner/ChinaScanner';
import { MarketId } from '@/lib/scanner/types';

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({})) as {
    market?: string;
    stocks?: Array<{ symbol: string; name: string }>;
  };

  const market = (body.market === 'CN' ? 'CN' : 'TW') as MarketId;
  const stocks = Array.isArray(body.stocks) ? body.stocks : [];

  if (stocks.length === 0) {
    return NextResponse.json({ results: [] });
  }

  try {
    const scanner = market === 'CN' ? new ChinaScanner() : new TaiwanScanner();
    const results = await scanner.scanList(stocks);
    return NextResponse.json({ results });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
