import { promises as fs } from 'node:fs';
import path from 'node:path';

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export interface StoredValuation<T = unknown> {
  valuation: T;
  date: string;
  requestedDate: string;
  fellBackFrom?: string;
  ageDays: number;
  updatedAt: string;
}

function calendarDaysBetween(from: string, to: string): number {
  const fromMs = Date.parse(`${from}T00:00:00Z`);
  const toMs = Date.parse(`${to}T00:00:00Z`);
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs)) return 0;
  return Math.max(0, Math.floor((toMs - fromMs) / 86_400_000));
}

/**
 * 讀取指定日當天或之前最近一份估值。
 *
 * 估值不是每天都會重跑，因此不能用固定「回查 7 天」判定是否存在；
 * 呼叫端會收到實際估值日與距指定日天數，讓 UI 明確標示新鮮度。
 */
export async function readLatestValuation<T = unknown>(options: {
  symbol: string;
  targetDate: string;
  rootDir?: string;
}): Promise<StoredValuation<T> | null> {
  const { symbol, targetDate } = options;
  if (!/^[A-Za-z0-9._-]+$/.test(symbol)) throw new Error('invalid symbol');
  if (!ISO_DATE_RE.test(targetDate)) throw new Error('invalid target date');

  const rootDir = options.rootDir ?? path.join(process.cwd(), 'data', 'valuation');
  let entries: Array<{ name: string; isDirectory(): boolean }>;
  try {
    entries = await fs.readdir(rootDir, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }

  const dates = entries
    .filter(entry => entry.isDirectory() && ISO_DATE_RE.test(entry.name) && entry.name <= targetDate)
    .map(entry => entry.name)
    .sort((a, b) => b.localeCompare(a));

  for (const date of dates) {
    const filePath = path.join(rootDir, date, `${symbol}.json`);
    try {
      const [raw, stat] = await Promise.all([
        fs.readFile(filePath, 'utf-8'),
        fs.stat(filePath),
      ]);
      return {
        valuation: JSON.parse(raw) as T,
        date,
        requestedDate: targetDate,
        ...(date === targetDate ? {} : { fellBackFrom: targetDate }),
        ageDays: calendarDaysBetween(date, targetDate),
        updatedAt: stat.mtime.toISOString(),
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw error;
    }
  }

  return null;
}
