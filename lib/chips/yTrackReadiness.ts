import { promises as fs } from 'fs';
import path from 'path';
import { readCandleFile } from '@/lib/datasource/CandleStorageAdapter';
import { readTurnoverRank } from '@/lib/scanner/TurnoverRank';
import { readInstitutionalTW } from '@/lib/storage/institutionalStorage';
import { syncInstitutionalDailyToStockCache } from './institutionalDailySync';
import { fetchYahooBrokerTrades } from '@/lib/datasource/YahooBrokerScraper';
import { appendBrokerDay } from './BrokerStorage';
import { getLastTradingDay } from '@/lib/datasource/marketHours';

const INST_DIR = path.join(process.cwd(), 'data', 'chips', 'TW', 'inst');
const BROKER_DIR = path.join(process.cwd(), 'data', 'chips', 'TW', 'broker');
const EXACT_DIR = path.join(process.cwd(), 'data', 'chips', 'TW', 'finmind-branch');

export const Y_TRACK_CURRENT_MIN_COVERAGE = 0.98;
export const Y_TRACK_STRATEGY_MIN_COVERAGE = 0.94;

export type YTrackConcentrationMode = 'finmind_exact' | 'yahoo_daily_approximate';

export interface YTrackReadiness {
  date: string;
  mode: YTrackConcentrationMode;
  requestedPool: number;
  tradedPool: number;
  institutionalCurrent: { count: number; coverage: number };
  brokerCurrent: { count: number; coverage: number };
  strategyWindow: { count: number; coverage: number; requiredDays: number };
  ready: boolean;
  reasons: string[];
  missingInstitutionalCurrent: string[];
  missingBrokerCurrent: string[];
}

export interface YTrackRepairResult {
  institutional: { attempted: boolean; written: number; missing: number };
  broker: { attempted: number; written: number; stale: number; failed: number };
}

type StockDateFile = { data?: Array<{ date: string }> };
type ExactDateFile = Record<string, { net?: Record<string, number> }>;

async function readDates(dir: string, code: string): Promise<Set<string>> {
  try {
    const parsed = JSON.parse(await fs.readFile(path.join(dir, `${code}.json`), 'utf8')) as StockDateFile;
    return new Set((parsed.data ?? []).map(row => row.date));
  } catch {
    return new Set();
  }
}

async function readExactDates(code: string): Promise<Set<string>> {
  try {
    const parsed = JSON.parse(await fs.readFile(path.join(EXACT_DIR, `${code}.json`), 'utf8')) as ExactDateFile;
    return new Set(Object.entries(parsed)
      .filter(([, row]) => Object.keys(row.net ?? {}).length > 0)
      .map(([date]) => date));
  } catch {
    return new Set();
  }
}

function ratio(count: number, total: number): number {
  return total > 0 ? +(count / total).toFixed(4) : 0;
}

async function defaultSymbols(): Promise<string[]> {
  const rank = await readTurnoverRank('TW');
  return rank ? Array.from(rank.symbols).slice(0, rank.topN) : [];
}

/**
 * Y 軌真正可評估覆蓋率。
 *
 * 近似模式需要兩個互不重疊的 5 日窗（今日與 5 日前）完整存在，因此要求最近 10 個
 * 交易日 broker 都在；不再容許 60% 殘窗被當成完整策略輸入。精確模式同樣要求最近
 * 10 日全分點快取，避免 evaluateLatest 悄悄退回較舊日期。
 */
export async function assessYTrackReadiness(
  date: string,
  symbols?: readonly string[],
): Promise<YTrackReadiness> {
  const requested = symbols ? Array.from(symbols) : await defaultSymbols();
  const mode: YTrackConcentrationMode = process.env.INSTSTEAL_NO_FINMIND === '1'
    ? 'yahoo_daily_approximate'
    : 'finmind_exact';

  let institutionalCurrentCount = 0;
  let brokerCurrentCount = 0;
  let strategyCount = 0;
  const tradedSymbols: string[] = [];
  const missingInstitutionalCurrent: string[] = [];
  const missingBrokerCurrent: string[] = [];
  const concurrency = 40;

  for (let i = 0; i < requested.length; i += concurrency) {
    const chunk = requested.slice(i, i + concurrency);
    const rows = await Promise.all(chunk.map(async symbol => {
      const file = await readCandleFile(symbol, 'TW').catch(() => null);
      const candles = (file?.candles ?? []).filter(candle => candle.date <= date);
      if (!candles.some(candle => candle.date === date)) return null;
      const code = symbol.replace(/\.(TW|TWO)$/i, '');
      const requiredDates = candles.slice(-10).map(candle => candle.date);
      const instWindow = requiredDates.slice(-5);
      const [instDates, brokerDates, exactDates] = await Promise.all([
        readDates(INST_DIR, code),
        readDates(BROKER_DIR, code),
        mode === 'finmind_exact' ? readExactDates(code) : Promise.resolve(new Set<string>()),
      ]);
      const instCurrent = instDates.has(date);
      const brokerCurrent = brokerDates.has(date);
      const fullWindow = requiredDates.length === 10
        && instWindow.every(day => instDates.has(day))
        && requiredDates.every(day => brokerDates.has(day))
        && (mode === 'yahoo_daily_approximate' || requiredDates.every(day => exactDates.has(day)));
      return { symbol, instCurrent, brokerCurrent, fullWindow };
    }));
    for (const row of rows) {
      if (!row) continue;
      tradedSymbols.push(row.symbol);
      if (row.instCurrent) institutionalCurrentCount++;
      else missingInstitutionalCurrent.push(row.symbol);
      if (row.brokerCurrent) brokerCurrentCount++;
      else missingBrokerCurrent.push(row.symbol);
      if (row.fullWindow) strategyCount++;
    }
  }

  const tradedPool = tradedSymbols.length;
  const institutionalCoverage = ratio(institutionalCurrentCount, tradedPool);
  const brokerCoverage = ratio(brokerCurrentCount, tradedPool);
  const strategyCoverage = ratio(strategyCount, tradedPool);
  const reasons: string[] = [];
  if (tradedPool === 0) reasons.push('沒有可交易股票可供檢查');
  if (institutionalCoverage < Y_TRACK_CURRENT_MIN_COVERAGE) {
    reasons.push(`法人當日覆蓋 ${(institutionalCoverage * 100).toFixed(1)}% < ${(Y_TRACK_CURRENT_MIN_COVERAGE * 100).toFixed(0)}%`);
  }
  if (brokerCoverage < Y_TRACK_CURRENT_MIN_COVERAGE) {
    reasons.push(`主力當日覆蓋 ${(brokerCoverage * 100).toFixed(1)}% < ${(Y_TRACK_CURRENT_MIN_COVERAGE * 100).toFixed(0)}%`);
  }
  if (strategyCoverage < Y_TRACK_STRATEGY_MIN_COVERAGE) {
    reasons.push(`策略完整 10 日窗覆蓋 ${(strategyCoverage * 100).toFixed(1)}% < ${(Y_TRACK_STRATEGY_MIN_COVERAGE * 100).toFixed(0)}%`);
  }

  return {
    date,
    mode,
    requestedPool: requested.length,
    tradedPool,
    institutionalCurrent: { count: institutionalCurrentCount, coverage: institutionalCoverage },
    brokerCurrent: { count: brokerCurrentCount, coverage: brokerCoverage },
    strategyWindow: { count: strategyCount, coverage: strategyCoverage, requiredDays: 10 },
    ready: reasons.length === 0,
    reasons,
    missingInstitutionalCurrent,
    missingBrokerCurrent,
  };
}

/** 只修可誠實修復的「當日」資料；Yahoo 不提供歷史，絕不把最新值倒填到舊日期。 */
export async function repairYTrackCurrentData(
  date: string,
  symbols: readonly string[],
): Promise<YTrackRepairResult> {
  const records = await readInstitutionalTW(date);
  let institutional = { attempted: false, written: 0, missing: symbols.length };
  if (records?.length) {
    const sync = await syncInstitutionalDailyToStockCache({
      date,
      records,
      universe: symbols,
      // 這裡只重播日檔中確實存在的列；未知來源不可補 0。
      sourceReady: { twse: false, tpex: false },
    });
    institutional = { attempted: true, written: sync.written, missing: sync.missing };
  }

  const before = await assessYTrackReadiness(date, symbols);
  const missing = before.missingBrokerCurrent;
  const broker = { attempted: 0, written: 0, stale: 0, failed: 0 };
  // Yahoo 只有最新日。歷史稽核不得打 500 次後再發現回的是今天。
  if (date === getLastTradingDay('TW')) {
    const concurrency = 6;
    for (let i = 0; i < missing.length; i += concurrency) {
      const chunk = missing.slice(i, i + concurrency);
      const results = await Promise.all(chunk.map(async symbol => {
        const code = symbol.replace(/\.(TW|TWO)$/i, '');
        broker.attempted++;
        try {
          const trades = await fetchYahooBrokerTrades(code);
          if (!trades) return 'failed' as const;
          if (trades.date !== date) return 'stale' as const;
          await appendBrokerDay(code, date, {
            netDifference: trades.totalDifferenceVolK,
            concentration: +(trades.concentration * 100).toFixed(2),
          });
          return 'written' as const;
        } catch {
          return 'failed' as const;
        }
      }));
      for (const result of results) broker[result]++;
    }
  }

  return { institutional, broker };
}
