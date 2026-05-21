/**
 * GET /api/cron/audit-l1-l2-consistency?market=TW|CN
 *
 * 每日 14:30 (TW) / 15:45 (CN) 跑：比對當日 L1 close 與 L2 close，偏差 >1% 寫 alert。
 *
 * 2026-05-21 加。背景：8358 金居案發現 L1 close 跟 L2 close 在 5/15+5/19+5/20 都有
 * 1-3.5% 偏差，全市場累計 ~660 檔×日壞 L1。原來 /health audit-l1-invariant 只看
 * sealedDate 不可變這條，沒比對 L1 vs L2。
 *
 * 出口：
 *   - apiOk({ market, date, total, diff_count, top: [...] })
 *   - 偏差 >1% 檔數超過 5 → 觸發 HEALTH_ALERT_WEBHOOK_URL
 *   - 100% L1 OHLC 自洽率（close 在 [low, high] 範圍內）也納入回傳
 */

import { NextRequest } from 'next/server';
import { apiOk, apiError } from '@/lib/api/response';
import { checkCronAuth } from '@/lib/api/cronAuth';
import { isTradingDay } from '@/lib/utils/tradingDay';
import { getLastTradingDay } from '@/lib/datasource/marketHours';
import { readCandleFile } from '@/lib/datasource/CandleStorageAdapter';

export const runtime = 'nodejs';
export const maxDuration = 60;

interface L2Quote { symbol: string; open: number; high: number; low: number; close: number; volume: number; }

async function readL2(market: 'TW' | 'CN', date: string): Promise<Map<string, L2Quote>> {
  const fs = await import('node:fs/promises');
  const path = await import('node:path');
  const file = path.join(process.cwd(), 'data', `intraday-${market}-${date}.json`);
  try {
    const raw = await fs.readFile(file, 'utf-8');
    const json = JSON.parse(raw) as { quotes?: L2Quote[] };
    const map = new Map<string, L2Quote>();
    for (const q of json.quotes ?? []) {
      if (q.close > 0) map.set(q.symbol, q);
    }
    return map;
  } catch { return new Map(); }
}

export async function GET(req: NextRequest) {
  const authDenied = checkCronAuth(req);
  if (authDenied) return authDenied;

  const market = (req.nextUrl.searchParams.get('market') ?? 'TW') as 'TW' | 'CN';
  if (market !== 'TW' && market !== 'CN') return apiError('market must be TW or CN', 400);
  const date = getLastTradingDay(market);
  if (!isTradingDay(date, market)) return apiOk({ skipped: true, reason: '非交易日' });

  const l2 = await readL2(market, date);
  if (l2.size === 0) {
    return apiOk({ skipped: true, reason: `無 L2 snapshot for ${date}` });
  }

  const scanner = market === 'TW'
    ? new (await import('@/lib/scanner/TaiwanScanner')).TaiwanScanner()
    : new (await import('@/lib/scanner/ChinaScanner')).ChinaScanner();
  const stocks = await scanner.getStockList();

  let totalChecked = 0;
  let diff1pct = 0;
  let diff5pct = 0;
  let ohlcInconsistent = 0;
  const samples: Array<{ symbol: string; l1: number; l2: number; pct: number }> = [];

  await Promise.allSettled(stocks.map(async ({ symbol }) => {
    const code = symbol.replace(/\.(TW|TWO|SS|SZ)$/i, '');
    const existing = await readCandleFile(symbol, market);
    if (!existing) return;
    const todayCandle = existing.candles.find(c => c.date === date);
    if (!todayCandle || todayCandle.close <= 0) return;
    totalChecked++;

    // OHLC 自洽
    if (todayCandle.close > todayCandle.high || todayCandle.close < todayCandle.low
        || todayCandle.open > todayCandle.high || todayCandle.open < todayCandle.low) {
      ohlcInconsistent++;
    }

    const l2q = l2.get(code);
    if (!l2q || l2q.close <= 0) return;
    const pct = Math.abs(todayCandle.close - l2q.close) / Math.max(todayCandle.close, l2q.close);
    if (pct > 0.05) diff5pct++;
    if (pct > 0.01) {
      diff1pct++;
      if (samples.length < 20) samples.push({ symbol, l1: todayCandle.close, l2: l2q.close, pct: Math.round(pct * 10000) / 100 });
    }
  }));

  samples.sort((a, b) => b.pct - a.pct);

  // Alert 條件：偏差檔數 > 5 或 OHLC 不自洽 > 0
  const shouldAlert = diff1pct > 5 || ohlcInconsistent > 0;
  if (shouldAlert) {
    const webhook = process.env.HEALTH_ALERT_WEBHOOK_URL;
    if (webhook) {
      fetch(webhook, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          text: `🚨 ${market} ${date} L1↔L2 audit: ${diff1pct}/${totalChecked} 檔偏差 >1%（${diff5pct} >5%），OHLC 不自洽 ${ohlcInconsistent}`,
          level: diff1pct > 50 || diff5pct > 5 ? 'critical' : 'warning',
          market,
          date,
          diff1pct,
          diff5pct,
          ohlcInconsistent,
        }),
      }).catch(() => {});
    }
    console.error(
      `[audit-l1-l2] ★ ${market} ${date}: ${diff1pct}/${totalChecked} 檔 L1↔L2 close 偏差 >1%`,
      `(>5%: ${diff5pct}, OHLC 不自洽: ${ohlcInconsistent})`,
    );
  }

  return apiOk({
    market,
    date,
    total: totalChecked,
    diff1pct,
    diff5pct,
    ohlcInconsistent,
    alertFired: shouldAlert,
    samples,
  });
}
