/**
 * 基本面補漲策略 runner（2026-05-27）
 *
 * 對全市場（或粗篩後）跑 pipeline，產生 Top 100 + 排除名單 + 寫盤。
 *
 * Concurrency：FinMind 速率限制嚴格（免費層 600 req/h），預設 concurrency=8、批間 jitter。
 *             EastMoney push2 較鬆，concurrency=16 OK。
 *
 * Universe（粗篩）：
 *   - 從 Layer 2 取全市場快照，沒快照退化為 scanner.getStockList()
 *   - 用「今日成交額」取前 300（避免冷門股、且控制 API 用量）
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
// Universe loader — 從 Layer 2 取「成交額排名前 N」
// ────────────────────────────────────────────────────────────────────────────

export interface UniverseEntry {
  symbol: string;
  name: string;
  todayPrice: number;
  averageTurnover20d?: number | null;
  industryCategory?: string | null;
}

async function loadSnapshotMap(market: 'TW' | 'CN', date: string): Promise<Map<string, { close: number; volume: number; name: string }>> {
  const { readIntradaySnapshot } = await import('@/lib/datasource/IntradayCache');
  const snap = await readIntradaySnapshot(market, date).catch(() => null);
  const map = new Map<string, { close: number; volume: number; name: string }>();
  if (!snap) return map;
  for (const q of snap.quotes) {
    map.set(q.symbol, { close: q.close, volume: q.volume, name: q.name });
  }
  return map;
}

async function loadUniverseTw(date: string, topN: number): Promise<UniverseEntry[]> {
  const { TaiwanScanner } = await import('@/lib/scanner/TaiwanScanner');
  const scanner = new TaiwanScanner();
  const stockList = await scanner.getStockList();
  const snapshot = await loadSnapshotMap('TW', date);

  const items: Array<{ entry: UniverseEntry; turnover: number }> = [];
  for (const s of stockList) {
    const code = s.symbol.replace(/\.(TW|TWO)$/i, '');
    const q = snapshot.get(code);
    if (!q || q.close <= 0 || q.volume <= 0) continue;
    const turnover = q.close * q.volume;
    items.push({
      entry: {
        symbol: code,
        name: s.name,
        todayPrice: q.close,
        averageTurnover20d: turnover,
      },
      turnover,
    });
  }
  items.sort((a, b) => b.turnover - a.turnover);
  return items.slice(0, topN).map((x) => x.entry);
}

async function loadUniverseCn(date: string, topN: number): Promise<UniverseEntry[]> {
  const { ChinaScanner } = await import('@/lib/scanner/ChinaScanner');
  const scanner = new ChinaScanner();
  const stockList = await scanner.getStockList();
  const snapshot = await loadSnapshotMap('CN', date);

  const items: Array<{ entry: UniverseEntry; turnover: number }> = [];
  for (const s of stockList) {
    const code = s.symbol.replace(/\.(SS|SZ)$/i, '');
    const q = snapshot.get(code);
    if (!q || q.close <= 0 || q.volume <= 0) continue;
    const turnover = q.close * q.volume;
    items.push({
      entry: {
        symbol: code,
        name: s.name,
        todayPrice: q.close,
        averageTurnover20d: turnover,
      },
      turnover,
    });
  }
  items.sort((a, b) => b.turnover - a.turnover);
  return items.slice(0, topN).map((x) => x.entry);
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
    opt.market === 'TW' ? await loadUniverseTw(opt.date, topN) : await loadUniverseCn(opt.date, topN);

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
