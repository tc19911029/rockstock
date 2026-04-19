import { NextRequest } from 'next/server';
import { z } from 'zod';
import type { CandleWithIndicators } from '@/types';
import type { MarketId, ScanSession, StockScanResult } from '@/lib/scanner/types';
import { loadLocalCandles } from '@/lib/datasource/LocalCandleStore';
import { listScanDates, loadScanSession } from '@/lib/storage/scanStorage';
import { applyPanelFilter } from '@/lib/selection/applyPanelFilter';
import { composeDailyActionList } from '@/lib/portfolio/dailyActionList';
import { loadLatestDabanCandidates } from '@/lib/portfolio/dabanAdapter';
import type { Holding } from '@/lib/portfolio/types';
import { apiOk, apiError, apiValidationError } from '@/lib/api/response';

export const runtime = 'nodejs';

const candleSchema = z.object({
  date: z.string(),
  open: z.number(),
  high: z.number(),
  low: z.number(),
  close: z.number(),
  volume: z.number(),
});

const holdingSchema = z.object({
  id: z.string(),
  symbol: z.string(),
  name: z.string().default(''),
  market: z.enum(['TW', 'CN']).default('TW'),
  shares: z.number().positive(),
  costPrice: z.number().positive(),
  buyDate: z.string(),
  entryKbar: candleSchema.optional(),
  notes: z.string().optional(),
});

const bodySchema = z.object({
  market: z.enum(['TW', 'CN', 'ALL']).default('ALL'),
  /** 各市場現金（兩個獨立帳戶） */
  cashBalance: z.object({
    TW: z.number().min(0).default(1_000_000),
    CN: z.number().min(0).default(1_000_000),
  }).default({ TW: 1_000_000, CN: 1_000_000 }),
  cashReservePct: z.number().min(0).max(100).default(0),
  useMultiTimeframe: z.boolean().default(false),
  holdings: z.array(holdingSchema).default([]),
  /** 已知最新報價（client 已透過 /api/portfolio/quotes 拿到的話傳進來省一輪） */
  currentPrices: z.record(z.string(), z.number()).optional(),
});

/**
 * 載入指定市場最新一場 long-daily scan session
 */
async function loadLatestLongSession(market: MarketId): Promise<ScanSession | null> {
  const dates = await listScanDates(market, 'long', 'daily');
  if (dates.length === 0) return null;
  const latest = dates[0];
  return loadScanSession(market, latest.date, 'long', 'daily');
}

export async function POST(req: NextRequest) {
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return apiError('invalid JSON body', 400);
  }

  const parsed = bodySchema.safeParse(raw);
  if (!parsed.success) return apiValidationError(parsed.error);

  const { market, cashBalance, cashReservePct, useMultiTimeframe, holdings: rawHoldings, currentPrices: clientPrices } = parsed.data;

  // ── 1. 載入候選池
  //   TW：六條件 long-daily
  //   CN：六條件 long-daily + 打板（兩套合併）
  const markets: MarketId[] = market === 'ALL' ? ['TW', 'CN'] : [market];
  const candidatesByMarket: Partial<Record<MarketId, StockScanResult[]>> = {};
  let asOfDate = '';

  for (const m of markets) {
    const merged: StockScanResult[] = [];

    // 六條件 long-daily（兩市場都有）
    const longSession = await loadLatestLongSession(m);
    if (longSession) {
      merged.push(...applyPanelFilter(longSession.results, { useMultiTimeframe }));
      if (!asOfDate || longSession.date > asOfDate) asOfDate = longSession.date;
    }

    // 打板（CN 才有）
    if (m === 'CN') {
      const { date, results } = await loadLatestDabanCandidates();
      // 去重：若打板候選在六條件已出現，保留六條件版（reasons 較完整）
      const seen = new Set(merged.map(r => r.symbol));
      for (const r of results) {
        if (!seen.has(r.symbol)) merged.push(r);
      }
      if (date && (!asOfDate || date > asOfDate)) asOfDate = date;
    }

    candidatesByMarket[m] = merged;
  }

  if (!asOfDate) {
    asOfDate = new Date().toISOString().split('T')[0];
  }

  // ── 2. 載入持倉 K 棒（含技術指標） ───────────────────────────────────
  const holdings: Holding[] = rawHoldings.map(h => ({
    ...h,
    name: h.name || h.symbol,
  }));
  const holdingCandles = new Map<string, CandleWithIndicators[]>();
  await Promise.all(holdings.map(async (h) => {
    try {
      const candles = await loadLocalCandles(h.symbol, h.market);
      if (candles && candles.length > 0) {
        holdingCandles.set(h.symbol, candles);
      }
    } catch {
      // skip — holding will be excluded from monitor list
    }
  }));

  // ── 3. 整理當前報價 ─────────────────────────────────────────────────
  const currentPrices = new Map<string, number>();
  if (clientPrices) {
    for (const [sym, price] of Object.entries(clientPrices)) {
      currentPrices.set(sym, price);
    }
  }
  // 若 client 沒給，從候選池抽該股票最新報價（可能不存在）
  for (const h of holdings) {
    if (currentPrices.has(h.symbol)) continue;
    const fromCandidates = (candidatesByMarket[h.market] ?? []).find(c => c.symbol === h.symbol);
    if (fromCandidates) currentPrices.set(h.symbol, fromCandidates.price);
  }

  // ── 4. 組合 DailyActionList ─────────────────────────────────────────
  const list = composeDailyActionList({
    asOfDate,
    market,
    cashBalance,
    cashReservePct,
    holdings,
    holdingCandles,
    currentPrices,
    candidatesByMarket,
  });

  return apiOk(list, {
    headers: { 'Cache-Control': 'no-store' },
  });
}
