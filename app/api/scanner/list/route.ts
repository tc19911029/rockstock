import { NextRequest, NextResponse } from 'next/server';

export const runtime = 'nodejs';
export const maxDuration = 30; // just fetching a list, fast

import { TaiwanScanner } from '@/lib/scanner/TaiwanScanner';
import { ChinaScanner } from '@/lib/scanner/ChinaScanner';
import { MarketId } from '@/lib/scanner/types';

export async function GET(req: NextRequest) {
  const market = (req.nextUrl.searchParams.get('market') ?? 'TW') as MarketId;
  const scanner = market === 'CN' ? new ChinaScanner() : new TaiwanScanner();

  try {
    const stocks = await scanner.getStockList();
    return NextResponse.json({ market, count: stocks.length, stocks });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
