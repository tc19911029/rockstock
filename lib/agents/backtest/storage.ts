/**
 * Backtest storage — data/agents/backtest/{market}/{date}.json
 */

import path from 'node:path';
import { promises as fs } from 'node:fs';
import { atomicFsPut } from '@/lib/storage/atomicFsPut';
import type { BacktestReport } from './types';
import type { MarketId } from '@/lib/scanner/types';

function getBacktestPath(market: MarketId, date: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error(`unsafe date: ${date}`);
  return path.join(process.cwd(), 'data', 'agents', 'backtest', market, `${date}.json`);
}

export async function saveBacktest(report: BacktestReport): Promise<string> {
  const file = getBacktestPath(report.market, report.date);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await atomicFsPut(file, JSON.stringify(report, null, 2));
  return file;
}

export async function loadBacktest(
  market: MarketId, date: string,
): Promise<BacktestReport | null> {
  try {
    const raw = await fs.readFile(getBacktestPath(market, date), 'utf-8');
    return JSON.parse(raw) as BacktestReport;
  } catch {
    return null;
  }
}

export async function listBacktestDates(market: MarketId): Promise<string[]> {
  const dir = path.join(process.cwd(), 'data', 'agents', 'backtest', market);
  try {
    const files = await fs.readdir(dir);
    return files
      .filter(f => /^\d{4}-\d{2}-\d{2}\.json$/.test(f))
      .map(f => f.replace(/\.json$/, ''))
      .sort((a, b) => b.localeCompare(a));
  } catch {
    return [];
  }
}
