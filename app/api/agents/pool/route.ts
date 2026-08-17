/**
 * GET /api/agents/pool?date=&market=&minSourceCount=&limit=&sort=
 *
 * 讀 data/agents/pool/{market}/{date}.json
 *
 * 參數：
 *   minSourceCount: 過濾掉 sourceCount < 此值的（預設讀 POOL_MIN_SOURCE_COUNT_DEFAULT）
 *   limit: 截 top N（預設 50）
 *   sort: 'sourceCount' (現有預設) 或 'weighted'（B3：≥N 共識後按 totalScore desc）
 *
 * B3 兩層過濾：
 *   1. 先 filter sourceCount >= minSourceCount
 *   2. 用 computeFacetScores(c) 算 totalScore，附在 response 上
 *   3. sort=weighted 時改用 totalScore 排序
 */

import { NextRequest } from 'next/server';
import { z } from 'zod';
import { apiOk, apiValidationError } from '@/lib/api/response';
import { loadPool } from '@/lib/agents/candidates/poolStorage';
import { getActiveStrategyServer } from '@/lib/strategy/activeStrategyServer';
import {
  computeFacetScores,
  POOL_MIN_SOURCE_COUNT_DEFAULT,
  POOL_WEIGHTS,
} from '@/lib/agents/candidates/poolWeights';
import { loadLocalCandlesForDate } from '@/lib/datasource/LocalCandleStore';
import { computeEntryState } from '@/lib/agents/entryGate';
import { detectMarketRegime, thresholdsForRegime } from '@/lib/agents/marketRegime';
import type { MarketId } from '@/lib/scanner/types';

export const runtime = 'nodejs';

const querySchema = z.object({
  market: z.enum(['TW', 'CN']).default('TW'),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  minSourceCount: z.coerce.number().int().min(1).max(4).default(POOL_MIN_SOURCE_COUNT_DEFAULT),
  limit: z.coerce.number().int().min(1).max(500).default(50),
  sort: z.enum(['sourceCount', 'weighted']).default('weighted'),
});

export async function GET(req: NextRequest) {
  const parsed = querySchema.safeParse(Object.fromEntries(new URL(req.url).searchParams));
  if (!parsed.success) return apiValidationError(parsed.error);
  const { market, date, minSourceCount, limit, sort } = parsed.data;

  const strategy = await getActiveStrategyServer();
  const pool = await loadPool(market as MarketId, date, strategy.id);
  if (!pool) {
    return apiOk({ date, market, exists: false, candidates: [], total: 0, weights: POOL_WEIGHTS });
  }

  // 第一層：≥N 面向共識
  const passed = pool.candidates.filter(c => c.sourceCount >= minSourceCount);

  // 算每檔 facet scores
  const withScores = passed.map(c => ({ ...c, scores: computeFacetScores(c) }));

  // 第二層排序
  if (sort === 'weighted') {
    withScores.sort((a, b) => b.scores.total - a.scores.total);
  }
  // sort === 'sourceCount' 時保留 pool 已排好的順序（sourceCount + strengthSignals）

  const sliced = withScores.slice(0, limit);

  // 大盤 regime 用 ^TWII（TW Market 才有意義；CN 暫保留 normal threshold）
  let regime: ReturnType<typeof detectMarketRegime> = {
    regime: 'normal', reasons: ['未取得大盤資料'],
    metrics: { closeVsMa20: null, closeVsMa60: null, fiveDayReturn: null, ma20VsMa60: null },
  };
  if (market === 'TW') {
    try {
      const indexCandles = await loadLocalCandlesForDate('^TWII', 'TW', date);
      regime = detectMarketRegime(indexCandles);
    } catch { /* keep normal default */ }
  }
  const gateThresholds = thresholdsForRegime(regime.regime);

  // 補上 lastClose（訊號日收盤）+ entry_state（書本進場時機 gate）
  // — pool JSON 沒存這欄，read 時從 L1 K 線拿並 runtime 算 entry_state（每天 candle 變動）
  const slicedWithLastClose = await Promise.all(
    sliced.map(async (c) => {
      let enriched = c;
      try {
        const candles = await loadLocalCandlesForDate(c.symbol, c.market as 'TW' | 'CN', date);
        if (!candles || candles.length === 0) return enriched;
        const last = candles[candles.length - 1];
        if (!last || last.date !== date) return enriched;
        if (enriched.lastClose == null) enriched = { ...enriched, lastClose: last.close };
        const gate = computeEntryState({ symbol: c.symbol, candles, thresholds: gateThresholds });
        enriched = {
          ...enriched,
          entryGate: {
            state: gate.state,
            reasons: gate.reasons,
            metrics: gate.metrics,
          },
        };
        return enriched;
      } catch {
        return enriched;
      }
    }),
  );

  return apiOk({
    date,
    market,
    exists: true,
    generatedAt: pool.generatedAt,
    strategyId: pool.strategyId ?? 'zhu-pure-book',
    sourceStatus: pool.sourceStatus,
    total: pool.candidates.length,
    eligibleTotal: passed.length,
    returned: slicedWithLastClose.length,
    minSourceCount,
    sort,
    weights: POOL_WEIGHTS,
    marketRegime: regime,
    distribution: {
      sourceCount4: pool.candidates.filter(c => c.sourceCount === 4).length,
      sourceCount3: pool.candidates.filter(c => c.sourceCount === 3).length,
      sourceCount2: pool.candidates.filter(c => c.sourceCount === 2).length,
      sourceCount1: pool.candidates.filter(c => c.sourceCount === 1).length,
    },
    candidates: slicedWithLastClose,
  });
}
