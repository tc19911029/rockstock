import fs from 'node:fs/promises';
import path from 'node:path';
import { readCandleFile } from '@/lib/datasource/CandleStorageAdapter';
import { loadOfficialIndustryContext } from '@/lib/themes/officialIndustryContext';

type InstitutionalRecord = {
  symbol: string;
  name: string;
  foreign: number;
  trust: number;
  dealer: number;
  total: number;
};

type InstitutionalDay = {
  date: string;
  records: InstitutionalRecord[];
};

export type TideProStock = {
  symbol: string;
  name: string;
  close: number | null;
  foreign: number;
  trust: number;
  dealer: number;
  total: number;
  foreignValue: number | null;
  trustValue: number | null;
  totalValue: number | null;
  streak: number;
  streakDirection: 'buy' | 'sell' | 'flat';
  intensity: number;
  badge: '土洋同買' | '土洋同賣' | '土洋對作' | '法人異常' | null;
};

export type TideProSnapshot = {
  date: string;
  historyDates: string[];
  simultaneousBuy: TideProStock[];
  simultaneousSell: TideProStock[];
  foreignStreaks: TideProStock[];
  intensityLeaders: TideProStock[];
  netLeaders: TideProStock[];
};

const DATA_DIR = path.join(process.cwd(), 'data', 'institutional');
const VALUE_THRESHOLD = 50_000_000;

function direction(value: number): 'buy' | 'sell' | 'flat' {
  return value > 0 ? 'buy' : value < 0 ? 'sell' : 'flat';
}

function consecutiveForeignDays(rows: InstitutionalRecord[]): number {
  const latestDirection = direction(rows.at(-1)?.foreign ?? 0);
  if (latestDirection === 'flat') return 0;
  let count = 0;
  for (let i = rows.length - 1; i >= 0; i -= 1) {
    if (direction(rows[i].foreign) !== latestDirection) break;
    count += 1;
  }
  return count;
}

function chipBadge(row: InstitutionalRecord, intensity: number): TideProStock['badge'] {
  if (row.foreign > 0 && row.trust > 0) return '土洋同買';
  if (row.foreign < 0 && row.trust < 0) return '土洋同賣';
  if (row.foreign * row.trust < 0) return '土洋對作';
  if (intensity >= 2.5) return '法人異常';
  return null;
}

async function latestClose(fullSymbol: string, date: string): Promise<number | null> {
  const file = await readCandleFile(fullSymbol, 'TW');
  if (!file?.candles?.length) return null;
  for (let i = file.candles.length - 1; i >= 0; i -= 1) {
    if (file.candles[i].date <= date) return file.candles[i].close;
  }
  return null;
}

export async function loadTideProSnapshot(): Promise<TideProSnapshot | null> {
  const officialContext = await loadOfficialIndustryContext().catch(() => null);
  if (!officialContext) return null;
  let filenames: string[];
  try {
    filenames = (await fs.readdir(DATA_DIR))
      .filter((name) => /^TW-\d{4}-\d{2}-\d{2}\.json$/.test(name))
      .sort()
      .slice(-20);
  } catch {
    return null;
  }
  if (filenames.length === 0) return null;

  const days = await Promise.all(filenames.map(async (filename) => {
    const raw = await fs.readFile(path.join(DATA_DIR, filename), 'utf8');
    return JSON.parse(raw) as InstitutionalDay;
  }));
  const latest = days.at(-1);
  if (!latest) return null;

  const bySymbol = new Map<string, InstitutionalRecord[]>();
  for (const day of days) {
    for (const row of day.records) {
      const rows = bySymbol.get(row.symbol) ?? [];
      rows.push(row);
      bySymbol.set(row.symbol, rows);
    }
  }

  // 先以籌碼規模縮小需要讀 K 線的範圍，避免一次掃全市場檔案。
  const candidates = latest.records
    // Tide 的個股榜單排除 ETF、權證、牛熊證與可轉債；四碼普通股才進榜。
    .filter((row) => /^\d{4}$/.test(row.symbol) && !row.symbol.startsWith('0') && officialContext.symbolByCode.has(row.symbol))
    .sort((a, b) => Math.abs(b.total) - Math.abs(a.total))
    .slice(0, 180);

  const stocks = await Promise.all(candidates.map(async (row): Promise<TideProStock> => {
    const history = bySymbol.get(row.symbol) ?? [row];
    const previous = history.slice(0, -1);
    const baseline = previous.length > 0
      ? previous.reduce((sum, item) => sum + Math.abs(item.total), 0) / previous.length
      : 0;
    const intensity = baseline > 0 ? Math.abs(row.total) / baseline : 0;
    const fullSymbol = officialContext.symbolByCode.get(row.symbol);
    const close = fullSymbol ? await latestClose(fullSymbol, latest.date) : null;
    return {
      symbol: row.symbol,
      name: row.name,
      close,
      foreign: row.foreign,
      trust: row.trust,
      dealer: row.dealer,
      total: row.total,
      foreignValue: close == null ? null : row.foreign * close,
      trustValue: close == null ? null : row.trust * close,
      totalValue: close == null ? null : row.total * close,
      streak: consecutiveForeignDays(history),
      streakDirection: direction(row.foreign),
      intensity: Number(intensity.toFixed(1)),
      badge: chipBadge(row, intensity),
    };
  }));

  const simultaneousBuy = stocks
    .filter((stock) => (stock.foreignValue ?? 0) >= VALUE_THRESHOLD && (stock.trustValue ?? 0) >= VALUE_THRESHOLD)
    .sort((a, b) => Math.min(b.foreignValue ?? 0, b.trustValue ?? 0) - Math.min(a.foreignValue ?? 0, a.trustValue ?? 0));
  const simultaneousSell = stocks
    .filter((stock) => (stock.foreignValue ?? 0) <= -VALUE_THRESHOLD && (stock.trustValue ?? 0) <= -VALUE_THRESHOLD)
    .sort((a, b) => Math.min(a.foreignValue ?? 0, a.trustValue ?? 0) - Math.min(b.foreignValue ?? 0, b.trustValue ?? 0));

  return {
    date: latest.date,
    historyDates: days.map((day) => day.date),
    simultaneousBuy: simultaneousBuy.slice(0, 30),
    simultaneousSell: simultaneousSell.slice(0, 30),
    foreignStreaks: stocks
      .filter((stock) => stock.streak >= 3)
      .sort((a, b) => b.streak - a.streak || Math.abs(b.foreignValue ?? 0) - Math.abs(a.foreignValue ?? 0))
      .slice(0, 40),
    intensityLeaders: stocks
      .filter((stock) => stock.intensity >= 1)
      .sort((a, b) => b.intensity - a.intensity)
      .slice(0, 40),
    netLeaders: stocks
      .sort((a, b) => Math.abs(b.totalValue ?? 0) - Math.abs(a.totalValue ?? 0))
      .slice(0, 50),
  };
}
