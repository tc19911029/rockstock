import { NextRequest, NextResponse } from 'next/server';
import { fetchCandlesYahoo } from '@/lib/datasource/YahooFinanceDS';
import { evaluateSixConditions } from '@/lib/analysis/trendAnalysis';

export interface SignalDate {
  date: string;
  score: number;
  close: number;
  // Forward returns (null if not enough data)
  d1Return: number | null;
  d5Return: number | null;
  d10Return: number | null;
  d20Return: number | null;
  maxGain5: number | null;  // max gain within 5 days
  maxLoss5: number | null;  // max loss within 5 days
}

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const symbol = searchParams.get('symbol') ?? '';
  const period = searchParams.get('period') ?? '2y';
  const minScore = parseInt(searchParams.get('minScore') ?? '4');

  if (!symbol) return NextResponse.json({ error: 'Missing symbol' }, { status: 400 });

  try {
    // fetchCandlesYahoo(ticker, period, timeoutMs?, asOfDate?)
    // It already calls computeIndicators internally
    const candles = await fetchCandlesYahoo(symbol, period, 30000);
    if (!candles || candles.length < 30) {
      return NextResponse.json({ error: '資料不足' }, { status: 404 });
    }

    const signals: SignalDate[] = [];

    for (let i = 30; i < candles.length - 1; i++) {
      const six = evaluateSixConditions(candles, i);
      if (six.totalScore < minScore) continue;

      const entry = candles[i].close;
      const get = (offset: number) => candles[i + offset]?.close ?? null;
      const ret = (c: number | null) => c != null ? (c - entry) / entry * 100 : null;

      // Max gain/loss over next 5 candles
      let maxG = 0, maxL = 0;
      for (let k = 1; k <= 5 && i + k < candles.length; k++) {
        const pct = (candles[i + k].close - entry) / entry * 100;
        if (pct > maxG) maxG = pct;
        if (pct < maxL) maxL = pct;
      }

      signals.push({
        date: candles[i].date,
        score: six.totalScore,
        close: entry,
        d1Return: ret(get(1)),
        d5Return: ret(get(5)),
        d10Return: ret(get(10)),
        d20Return: ret(get(20)),
        maxGain5: maxG,
        maxLoss5: maxL,
      });
    }

    // Aggregate stats
    const total = signals.length;
    const win1  = signals.filter(s => (s.d1Return ?? 0) > 0).length;
    const win5  = signals.filter(s => (s.d5Return ?? 0) > 0).length;
    const win20 = signals.filter(s => (s.d20Return ?? 0) > 0).length;
    const avg5  = total > 0 ? signals.reduce((s, x) => s + (x.d5Return ?? 0), 0) / total : 0;
    const avg20 = total > 0 ? signals.reduce((s, x) => s + (x.d20Return ?? 0), 0) / total : 0;

    return NextResponse.json({
      symbol,
      signals: signals.reverse(), // newest first
      stats: { total, win1, win5, win20, avg5, avg20 },
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
