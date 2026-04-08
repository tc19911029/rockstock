/**
 * POST /api/scanner/daban/openprices
 *
 * 即時取得打板掃描股票的當日開盤價（用於 9:25 集合競價後快速判斷是否達到買入門檻）
 * 使用東方財富 push2 即時報價 API，30 秒快取。
 */
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { getEastMoneyRealtime } from '@/lib/datasource/EastMoneyRealtime';

const requestSchema = z.object({
  symbols: z.array(z.string()).min(1).max(200),
});

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const parsed = requestSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json({ error: '參數錯誤' }, { status: 400 });
    }

    const { symbols } = parsed.data;
    const quotes = await getEastMoneyRealtime();

    const prices: Record<string, { open: number; close: number; high: number; low: number }> = {};

    for (const symbol of symbols) {
      // Convert "600519.SS" / "000001.SZ" → "600519" / "000001"
      const code = symbol.replace(/\.(SS|SZ)$/, '');
      const q = quotes.get(code);
      if (q && q.open > 0) {
        prices[symbol] = {
          open: q.open,
          close: q.close,
          high: q.high,
          low: q.low,
        };
      }
    }

    return NextResponse.json({ ok: true, prices, fetchedAt: new Date().toISOString() });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : '即時報價取得失敗';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
