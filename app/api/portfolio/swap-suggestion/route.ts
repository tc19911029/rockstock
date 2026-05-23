/**
 * /api/portfolio/swap-suggestion — 零現金換股建議
 *
 * POST body:
 *   {
 *     "candidate": {
 *       "symbol": "2330.TW",
 *       "name": "台積電",
 *       "entryPrice": 1100,
 *       "industry": "半導體 - 晶圓代工",   // 可選，給集中度警示用
 *       "targetInvestment": 5000000        // 可選，想投入多少 NTD
 *     },
 *     "reviewLookbackDays": 7              // 可選，往前找 review 的天數，預設 7
 *   }
 *
 * Response:
 *   {
 *     "candidate": {...},
 *     "recommended": SwapCandidate,
 *     "alternatives": [...],
 *     "noActionRecommended": false,
 *     "warnings": [...],
 *     "buyEstimate": { shares, lots, totalCost, remainingCash }
 *   }
 *
 * 行為：
 *   - 讀 holdings.json open holdings（CN 不納入，與用戶 2026-05-23 決議一致）
 *   - 對每檔讀 data/candles/TW/{symbol}.json 最新 close 為 currentPrice
 *   - 找近 7 天 reviews/{date}.json 內 symbol 對應的 review（用最新一份）
 *   - 呼叫 recommendSwap 排序 + warnings
 *   - 對 recommended 算 buyEstimate（candidate 可買多少股）
 */

import { NextRequest } from 'next/server';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { z } from 'zod';
import { apiOk, apiError, apiValidationError } from '@/lib/api/response';
import { listOpenHoldings } from '@/lib/agents/portfolio/storage';
import {
  recommendSwap,
  estimateBuyShares,
  type HoldingForSwap,
} from '@/lib/portfolio/swapSuggestion';
import type { PortfolioHoldingReview, PortfolioReviewFile } from '@/lib/agents/portfolio/types';
import type { MarketId } from '@/lib/scanner/types';
import { marketFromSymbol } from '@/lib/utils/shareUnits';

export const runtime = 'nodejs';

const bodySchema = z.object({
  candidate: z.object({
    symbol: z.string().regex(/^[A-Za-z0-9._-]+$/),
    name: z.string().min(1),
    entryPrice: z.coerce.number().positive(),
    industry: z.string().optional(),
    targetInvestment: z.coerce.number().positive().optional(),
  }),
  reviewLookbackDays: z.coerce.number().int().positive().max(30).optional().default(7),
});

const REVIEWS_DIR = path.join(process.cwd(), 'data', 'agents', 'portfolio', 'reviews');

/** 載入近 N 天的 reviews，回 { symbol → 最新 review } */
async function loadRecentReviewsBySymbol(
  lookbackDays: number,
): Promise<Map<string, PortfolioHoldingReview>> {
  const out = new Map<string, PortfolioHoldingReview>();
  let entries: string[];
  try {
    entries = await fs.readdir(REVIEWS_DIR);
  } catch {
    return out;
  }
  const today = new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);
  const cutoff = new Date(Date.now() + 8 * 3600 * 1000 - lookbackDays * 86400 * 1000)
    .toISOString().slice(0, 10);

  const candidateFiles = entries
    .filter(name => /^\d{4}-\d{2}-\d{2}\.json$/.test(name))
    .map(name => name.replace(/\.json$/, ''))
    .filter(date => date >= cutoff && date <= today)
    .sort((a, b) => b.localeCompare(a));  // newest first

  for (const date of candidateFiles) {
    let parsed: PortfolioReviewFile;
    try {
      const raw = await fs.readFile(path.join(REVIEWS_DIR, `${date}.json`), 'utf-8');
      parsed = JSON.parse(raw) as PortfolioReviewFile;
    } catch { continue; }
    for (const r of parsed.reviews ?? []) {
      if (!out.has(r.symbol)) out.set(r.symbol, r);  // 第一次見即最新
    }
  }
  return out;
}

/** 載入 candles 取最新 close */
async function loadLatestClose(
  symbol: string, market: MarketId,
): Promise<number | null> {
  const candlesPath = path.join(
    process.cwd(), 'data', 'candles', market, `${symbol}.json`,
  );
  try {
    const raw = await fs.readFile(candlesPath, 'utf-8');
    const data = JSON.parse(raw) as { candles?: Array<{ date: string; close: number }> };
    const candles = data.candles ?? [];
    if (candles.length === 0) return null;
    return candles[candles.length - 1].close;
  } catch {
    return null;
  }
}

export async function POST(req: NextRequest) {
  let body: unknown;
  try { body = await req.json(); } catch { return apiError('invalid JSON body', 400); }
  const parsed = bodySchema.safeParse(body);
  if (!parsed.success) return apiValidationError(parsed.error);

  const { candidate, reviewLookbackDays } = parsed.data;

  // 讀 TW-only holdings（CN 排除）
  const allHoldings = await listOpenHoldings();
  const twHoldings: HoldingForSwap[] = allHoldings
    .filter(h => h.market === 'TW')
    .map(h => ({
      symbol: h.symbol,
      name: h.name,
      market: h.market,
      industry: h.industry,
      entryDate: h.entryDate,
      entryPrice: h.entryPrice,
      shares: h.shares,
      stopLoss: h.stopLoss,
    }));

  // 並行載入 reviews + currentPrices
  const [reviewsBySymbol, prices] = await Promise.all([
    loadRecentReviewsBySymbol(reviewLookbackDays),
    Promise.all(twHoldings.map(async h => [
      h.symbol, await loadLatestClose(h.symbol, h.market),
    ] as const)),
  ]);
  const currentPrices = new Map<string, number>();
  for (const [symbol, close] of prices) {
    if (close != null) currentPrices.set(symbol, close);
  }

  // 排序 + 警示
  const rec = recommendSwap({
    candidate,
    holdings: twHoldings,
    currentPrices,
    reviewsBySymbol,
  });

  // 對 recommended / sizeFit 各算一份 buyEstimate
  const candidateMarket = (marketFromSymbol(candidate.symbol) as MarketId) ?? 'TW';
  const buyEstimate = rec.recommended
    ? estimateBuyShares(rec.recommended.proceedsNet, { entryPrice: candidate.entryPrice, market: candidateMarket })
    : null;
  const buyEstimateSizeFit = rec.sizeFit
    ? estimateBuyShares(rec.sizeFit.proceedsNet, { entryPrice: candidate.entryPrice, market: candidateMarket })
    : null;

  return apiOk({
    candidate,
    holdingsConsidered: twHoldings.length,
    reviewsFound: reviewsBySymbol.size,
    pricesFound: currentPrices.size,
    recommended: rec.recommended,
    sizeFit: rec.sizeFit,
    alternatives: rec.alternatives,
    noActionRecommended: rec.noActionRecommended,
    reason: rec.reason,
    warnings: rec.warnings,
    buyEstimate,
    buyEstimateSizeFit,
  });
}
