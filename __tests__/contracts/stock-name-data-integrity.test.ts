import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { isPlaceholderStockName } from '@/lib/stocks/stockIdentity';

function jsonFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry.startsWith('.')) continue;
    const full = path.join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) out.push(...jsonFiles(full));
    else if (entry.endsWith('.json')) out.push(full);
  }
  return out;
}

function stockLike(value: unknown): value is string {
  return typeof value === 'string' && /^\d{4,6}(?:\.(?:TW|TWO|SS|SZ|OF))?$/i.test(value.trim());
}

function findViolations(value: unknown, file: string, pointer = '$'): string[] {
  if (Array.isArray(value)) {
    return value.flatMap((item, index) => findViolations(item, file, `${pointer}[${index}]`));
  }
  if (!value || typeof value !== 'object') return [];

  const row = value as Record<string, unknown>;
  const symbol = stockLike(row.symbol) ? row.symbol
    : stockLike(row.stock_symbol) ? row.stock_symbol
      : stockLike(row.code) ? row.code
        : stockLike(row.stock_code) ? row.stock_code
          : null;
  const name = typeof row.name === 'string' ? row.name
    : typeof row.stock_name === 'string' ? row.stock_name
      : null;
  const current = symbol && name && isPlaceholderStockName(name, symbol)
    ? [`${path.relative(process.cwd(), file)}:${pointer} (${symbol})`]
    : [];
  return current.concat(Object.entries(row).flatMap(([key, child]) =>
    findViolations(child, file, `${pointer}.${key}`),
  ));
}

describe('已提交資料不得以股票代號冒充名稱', () => {
  test('持倉、自選、題材、警示與分析資料的股票 name 不可等於 symbol/code', () => {
    const dataDir = path.join(process.cwd(), 'data');
    const criticalDirs = [
      'agents', 'portfolio', 'portfolios', 'lock-watch', 'lockwatch-roster',
      'paper-portfolio', 'realtime', 'sectors', 'strategies', 'theme-sanse',
      'youtube', 'cn-media',
    ].map(name => path.join(dataDir, name));
    const violations: string[] = [];
    for (const file of criticalDirs.flatMap(dir => {
      try { return jsonFiles(dir); } catch { return []; }
    })) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(readFileSync(file, 'utf8'));
      } catch {
        continue;
      }
      violations.push(...findViolations(parsed, file));
      if (violations.length >= 50) break;
    }
    expect(violations).toEqual([]);
  }, 30_000);
});
