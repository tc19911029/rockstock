/**
 * 基本面補漲策略 runner（2026-05-27）
 *
 * 對全市場（或粗篩後）跑 pipeline，產生 Top 100 + 排除名單 + 寫盤。
 *
 * Concurrency：FinMind 速率限制嚴格（免費層 600 req/h），預設 concurrency=8、批間 jitter。
 *             EastMoney push2 較鬆，concurrency=16 OK。
 *
 * Universe（粗篩）：
 *   - 從 sealed L1 計算指定日期的 20 日均成交額排名
 *   - 取前 300（避免冷門股、且控制資料處理量）
 */

import { runTwSingle, type TwPipelineInput } from './twPipeline';
import { runCnSingle, type CnPipelineInput } from './cnPipeline';
import type {
  FundamentalRevaluationResult,
  FundamentalRevaluationSession,
} from './types';

const TW_UNIVERSE_TOP = 300;
const CN_UNIVERSE_TOP = 300;

const TW_CONCURRENCY = 8;
const CN_CONCURRENCY = 16;

const VERSION_TW = 'tw-fundamental-revaluation@1.0.0';
const VERSION_CN = 'cn-fundamental-revaluation@1.0.0';

// ────────────────────────────────────────────────────────────────────────────
// Universe loader — 從 sealed L1 取「成交額排名前 N」
// ────────────────────────────────────────────────────────────────────────────

export interface UniverseEntry {
  symbol: string;
  name: string;
  todayPrice: number;
  averageTurnover20d?: number | null;
  industryCategory?: string | null;
}

async function loadUniverse(market: 'TW' | 'CN', date: string, topN: number): Promise<UniverseEntry[]> {
  const [{ computeTurnoverRankAsOfDate }, { readCandleFile }] = await Promise.all([
    import('@/lib/scanner/TurnoverRank'),
    import('@/lib/datasource/CandleStorageAdapter'),
  ]);
  const scanner = market === 'TW'
    ? new (await import('@/lib/scanner/TaiwanScanner')).TaiwanScanner()
    : new (await import('@/lib/scanner/ChinaScanner')).ChinaScanner();
  const stockList = await scanner.getStockList();
  const ranks = await computeTurnoverRankAsOfDate(market, stockList, date, topN);
  const selected = stockList
    .filter((stock) => ranks.has(stock.symbol))
    .sort((a, b) => (ranks.get(a.symbol) ?? Infinity) - (ranks.get(b.symbol) ?? Infinity));
  const entries: UniverseEntry[] = [];
  const concurrency = 30;
  for (let i = 0; i < selected.length; i += concurrency) {
    const batch = selected.slice(i, i + concurrency);
    const settled = await Promise.all(batch.map(async (stock) => {
      const file = await readCandleFile(stock.symbol, market);
      const candle = file?.candles.find((row) => row.date.slice(0, 10) === date);
      if (!candle || candle.close <= 0) return null;
      return {
        symbol: stock.symbol.replace(market === 'TW' ? /\.(TW|TWO)$/i : /\.(SS|SZ)$/i, ''),
        name: stock.name,
        todayPrice: candle.close,
        // 已由 20 日均成交額排名選過；不再拿單日成交額冒充 20 日均值。
        averageTurnover20d: null,
      } satisfies UniverseEntry;
    }));
    for (const entry of settled) if (entry) entries.push(entry);
  }
  return entries.slice(0, topN);
}

// ────────────────────────────────────────────────────────────────────────────
// Concurrency-limited map
// ────────────────────────────────────────────────────────────────────────────

async function pMap<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T, idx: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let idx = 0;
  async function worker() {
    while (true) {
      const i = idx++;
      if (i >= items.length) return;
      try {
        results[i] = await fn(items[i], i);
      } catch (err) {
        // 單檔失敗不阻斷批次
        console.error('[fundamental-revaluation] item failed', i, items[i], err);
        results[i] = null as R;
      }
    }
  }
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, () => worker());
  await Promise.all(workers);
  return results;
}

// ────────────────────────────────────────────────────────────────────────────
// 主執行器
// ────────────────────────────────────────────────────────────────────────────

export interface RunOptions {
  market: 'TW' | 'CN';
  date: string;
  topN?: number;
  /** 0-1 之間；資料齊全度低於此值的股票不進 Top 100（過濾雜訊） */
  minDataCompleteness?: number;
}

export async function runFundamentalRevaluation(
  opt: RunOptions,
): Promise<FundamentalRevaluationSession> {
  const topN = opt.topN ?? (opt.market === 'TW' ? TW_UNIVERSE_TOP : CN_UNIVERSE_TOP);
  const minCompleteness = opt.minDataCompleteness ?? 0.5;

  const universe =
    await loadUniverse(opt.market, opt.date, topN);

  console.info(`[fundamental-revaluation] ${opt.market} universe size: ${universe.length}`);

  const results: FundamentalRevaluationResult[] = [];

  if (opt.market === 'TW') {
    const arr = await pMap(universe, TW_CONCURRENCY, async (u): Promise<FundamentalRevaluationResult | null> => {
      const input: TwPipelineInput = {
        symbol: u.symbol,
        name: u.name,
        todayPrice: u.todayPrice,
        priceDate: opt.date,
        averageTurnover20d: u.averageTurnover20d ?? null,
      };
      return runTwSingle(input);
    });
    for (const r of arr) if (r) results.push(r);
  } else {
    const arr = await pMap(universe, CN_CONCURRENCY, async (u): Promise<FundamentalRevaluationResult | null> => {
      const input: CnPipelineInput = {
        symbol: u.symbol,
        name: u.name,
        todayPrice: u.todayPrice,
        priceDate: opt.date,
        industryCategory: u.industryCategory ?? null,
        averageTurnover20d: u.averageTurnover20d ?? null,
      };
      return runCnSingle(input);
    });
    for (const r of arr) if (r) results.push(r);
  }

  // 排序：總分 desc，同分依資料齊全度 desc
  results.sort((a, b) => {
    if (b.breakdown.total !== a.breakdown.total) return b.breakdown.total - a.breakdown.total;
    return b.dataCompleteness - a.dataCompleteness;
  });

  // 過濾資料齊全度太低的（避免雜訊）
  const qualityResults = results.filter((r) => r.dataCompleteness >= minCompleteness);

  // 取 Top 100，rank 賦值
  const top100 = qualityResults.slice(0, 100).map((r, i) => ({ ...r, rank: i + 1 }));

  // 排除名單
  const oneTimeGainExcluded: FundamentalRevaluationSession['exclusionLists']['oneTimeGainExcluded'] = [];
  const deductedNetProfitPoor: FundamentalRevaluationSession['exclusionLists']['deductedNetProfitPoor'] = [];
  const valuationStretched: FundamentalRevaluationSession['exclusionLists']['valuationStretched'] = [];
  const cyclicalPeak: FundamentalRevaluationSession['exclusionLists']['cyclicalPeak'] = [];
  const insufficientData: FundamentalRevaluationSession['exclusionLists']['insufficientData'] = [];

  for (const r of results) {
    const flags = r.breakdown.flags;
    if (r.dataCompleteness < minCompleteness) {
      insufficientData.push({ symbol: r.symbol, name: r.name, reason: `資料齊全度 ${(r.dataCompleteness * 100).toFixed(0)}%` });
    }
    if (flags.includes('one_time_gain') && opt.market === 'TW') {
      oneTimeGainExcluded.push({ symbol: r.symbol, name: r.name, reason: '一次性收益旗觸發' });
    }
    if (flags.includes('one_time_gain') && opt.market === 'CN') {
      const ratio = (r.bundle as { deductedNetProfitRatio?: number | null }).deductedNetProfitRatio;
      deductedNetProfitPoor.push({
        symbol: r.symbol,
        name: r.name,
        reason: ratio != null ? `扣非/歸母 ${(ratio * 100).toFixed(0)}%` : '扣非品質不佳',
      });
    }
    if (flags.includes('valuation_stretched')) {
      valuationStretched.push({ symbol: r.symbol, name: r.name, reason: '現價已反映樂觀情境' });
    }
    if (flags.includes('cyclical_peak')) {
      cyclicalPeak.push({ symbol: r.symbol, name: r.name, reason: '景氣循環處於高峰' });
    }
  }

  const session: FundamentalRevaluationSession = {
    market: opt.market,
    date: opt.date,
    strategyVersion: opt.market === 'TW' ? VERSION_TW : VERSION_CN,
    computedAt: new Date().toISOString(),
    totalCandidates: universe.length,
    evaluatedCount: results.length,
    top100,
    exclusionLists: {
      oneTimeGainExcluded: oneTimeGainExcluded.slice(0, 50),
      deductedNetProfitPoor: deductedNetProfitPoor.slice(0, 50),
      valuationStretched: valuationStretched.slice(0, 50),
      cyclicalPeak: cyclicalPeak.slice(0, 50),
      insufficientData: insufficientData.slice(0, 50),
    },
  };

  return session;
}
