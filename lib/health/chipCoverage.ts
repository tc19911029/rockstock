import { promises as fs } from 'fs';
import path from 'path';
import { readTurnoverRank } from '@/lib/scanner/TurnoverRank';
import { readCandleFile } from '@/lib/datasource/CandleStorageAdapter';
import { calculateApproxBrokerConcentration } from '@/lib/chips/approxConcentration';

export interface ChipCoverageSnapshot {
  date: string;
  poolSize: number;
  institutional: { count: number; coverage: number };
  broker: { count: number; coverage: number };
  concentration: {
    mode: 'exact' | 'approximate';
    count: number;
    coverage: number;
    label: string;
    window5d: { count: number; coverage: number };
    window20d: { count: number; coverage: number };
  };
  level: 'green' | 'yellow' | 'red';
}

async function hasStockDate(dir: string, code: string, date: string): Promise<boolean> {
  try {
    const parsed = JSON.parse(await fs.readFile(path.join(dir, `${code}.json`), 'utf8')) as {
      data?: Array<{ date: string }>;
    };
    return (parsed.data ?? []).some(row => row.date === date);
  } catch {
    return false;
  }
}

async function hasExactDate(dir: string, code: string, date: string): Promise<boolean> {
  try {
    const parsed = JSON.parse(await fs.readFile(path.join(dir, `${code}.json`), 'utf8')) as Record<
      string,
      { net?: Record<string, number> }
    >;
    return Object.keys(parsed[date]?.net ?? {}).length > 0;
  } catch {
    return false;
  }
}

async function readBrokerMetrics(
  dir: string,
  code: string,
  date: string,
  candles: readonly { date: string; volume: number }[],
): Promise<{ current: boolean; window5d: boolean; window20d: boolean }> {
  try {
    const parsed = JSON.parse(await fs.readFile(path.join(dir, `${code}.json`), 'utf8')) as {
      data?: Array<{ date: string; netDifference: number }>;
    };
    const data = parsed.data ?? [];
    return {
      current: data.some(row => row.date === date),
      window5d: calculateApproxBrokerConcentration(candles, data, date, 5).value != null,
      window20d: calculateApproxBrokerConcentration(candles, data, date, 20).value != null,
    };
  } catch {
    return { current: false, window5d: false, window20d: false };
  }
}

export function assessChipCoverageLevel(
  institutional: number,
  broker: number,
  concentrationWindow = 1,
): 'green' | 'yellow' | 'red' {
  if (institutional < 0.9 || broker < 0.9 || concentrationWindow < 0.9) return 'red';
  if (institutional < 0.95 || broker < 0.95 || concentrationWindow < 0.95) return 'yellow';
  return 'green';
}

export async function getChipCoverageSnapshot(date: string): Promise<ChipCoverageSnapshot> {
  const rank = await readTurnoverRank('TW');
  const ranked = rank ? Array.from(rank.symbols).slice(0, rank.topN) : [];
  const symbols: string[] = [];
  const candlesBySymbol = new Map<string, Array<{ date: string; volume: number }>>();
  const tradeConcurrency = 40;
  for (let i = 0; i < ranked.length; i += tradeConcurrency) {
    const chunk = ranked.slice(i, i + tradeConcurrency);
    const traded = await Promise.all(chunk.map(async symbol => {
      const file = await readCandleFile(symbol, 'TW').catch(() => null);
      if (!file?.candles.some(candle => candle.date === date)) return null;
      candlesBySymbol.set(symbol, file.candles);
      return symbol;
    }));
    symbols.push(...traded.filter((symbol): symbol is string => !!symbol));
  }
  const root = path.join(process.cwd(), 'data', 'chips', 'TW');
  const noFinmind = process.env.INSTSTEAL_NO_FINMIND === '1';

  let institutionalCount = 0;
  let brokerCount = 0;
  let exactCount = 0;
  let approx5Count = 0;
  let approx20Count = 0;
  const concurrency = 40;
  for (let i = 0; i < symbols.length; i += concurrency) {
    const chunk = symbols.slice(i, i + concurrency);
    const rows = await Promise.all(chunk.map(async symbol => {
      const code = symbol.replace(/\.(TW|TWO)$/i, '');
      const brokerMetrics = readBrokerMetrics(
        path.join(root, 'broker'),
        code,
        date,
        candlesBySymbol.get(symbol) ?? [],
      );
      return Promise.all([
        hasStockDate(path.join(root, 'inst'), code, date),
        brokerMetrics,
        noFinmind ? Promise.resolve(false) : hasExactDate(path.join(root, 'finmind-branch'), code, date),
      ]);
    }));
    for (const [inst, broker, exact] of rows) {
      if (inst) institutionalCount++;
      if (broker.current) brokerCount++;
      if (broker.window5d) approx5Count++;
      if (broker.window20d) approx20Count++;
      if (exact) exactCount++;
    }
  }

  const poolSize = symbols.length;
  const pct = (count: number) => poolSize > 0 ? +(count / poolSize).toFixed(4) : 0;
  const institutionalCoverage = pct(institutionalCount);
  const brokerCoverage = pct(brokerCount);
  const concentrationCount = noFinmind ? brokerCount : exactCount;

  return {
    date,
    poolSize,
    institutional: { count: institutionalCount, coverage: institutionalCoverage },
    broker: { count: brokerCount, coverage: brokerCoverage },
    concentration: {
      mode: noFinmind ? 'approximate' : 'exact',
      count: concentrationCount,
      coverage: pct(concentrationCount),
      label: noFinmind ? 'Yahoo 每日前15大近似' : 'FinMind 全分點正式值',
      window5d: { count: approx5Count, coverage: pct(approx5Count) },
      window20d: { count: approx20Count, coverage: pct(approx20Count) },
    },
    level: poolSize === 0
      ? 'red'
      : assessChipCoverageLevel(
        institutionalCoverage,
        brokerCoverage,
        noFinmind ? pct(approx20Count) : pct(exactCount),
      ),
  };
}
