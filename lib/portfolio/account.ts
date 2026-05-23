/**
 * 帳戶總資金事實表（Phase 0.3）
 *
 * 為什麼需要：sizer / growthPath / 月報全部要讀「現在有多少錢」，
 * 但目前 holdings.json 只記持股、無現金、無 stockValue 滾動快照。
 *
 * Schema：
 *   data/portfolio/account.json
 *   {
 *     schemaVersion: 1,
 *     cash: 0,                              // 手動維護
 *     stockValue: 70_000_000,               // recalcStockValue() 算
 *     totalCapital: 70_000_000,             // cash + stockValue
 *     asOfDate: '2026-05-22',               // recalc 使用的 K 線最新日期
 *     holdingsSnapshot: [
 *       { symbol, shares, close, value, closeDate }
 *     ],
 *     updatedAt: '...'
 *   }
 *
 * 不違反 FUNDAMENTAL_REQUIREMENTS：
 *   - Layer 1 / 2 / 3 / 4 全不碰
 *   - 只讀 data/candles/{market}/{symbol}.json (與 validateEntryPrice 同源)
 *   - cash 不會自動變動，只能透過 POST /api/portfolio/account 手動更新
 */

import path from 'node:path';
import { promises as fs } from 'node:fs';
import type { MarketId } from '@/lib/scanner/types';
import { atomicFsPut } from '@/lib/storage/atomicFsPut';
import { listOpenHoldings } from '@/lib/agents/portfolio/storage';

export const ACCOUNT_SCHEMA_VERSION = 1 as const;

export interface AccountHoldingSnapshot {
  symbol: string;
  market: MarketId;
  shares: number;
  close: number | null;       // 沒抓到 K 線回 null（不擋）
  closeDate: string | null;
  value: number;              // shares × close（close=null 時 0）
}

export interface AccountFile {
  schemaVersion: typeof ACCOUNT_SCHEMA_VERSION;
  cash: number;
  stockValue: number;
  totalCapital: number;
  asOfDate: string | null;
  holdingsSnapshot: AccountHoldingSnapshot[];
  updatedAt: string;
}

const ACCOUNT_DIR = path.join(process.cwd(), 'data', 'portfolio');
const ACCOUNT_FILE = path.join(ACCOUNT_DIR, 'account.json');

export async function loadAccount(): Promise<AccountFile> {
  try {
    const raw = await fs.readFile(ACCOUNT_FILE, 'utf-8');
    return JSON.parse(raw) as AccountFile;
  } catch {
    return {
      schemaVersion: ACCOUNT_SCHEMA_VERSION,
      cash: 0,
      stockValue: 0,
      totalCapital: 0,
      asOfDate: null,
      holdingsSnapshot: [],
      updatedAt: new Date().toISOString(),
    };
  }
}

async function saveAccount(file: AccountFile): Promise<void> {
  await fs.mkdir(ACCOUNT_DIR, { recursive: true });
  file.updatedAt = new Date().toISOString();
  await atomicFsPut(ACCOUNT_FILE, JSON.stringify(file, null, 2));
}

/** 純函式：給 holdings + close prices map → 算 stockValue + snapshot */
export function computeStockValue(
  holdings: ReadonlyArray<{ symbol: string; market: MarketId; shares: number }>,
  closesBySymbol: ReadonlyMap<string, { close: number; date: string } | null>,
): { stockValue: number; asOfDate: string | null; holdingsSnapshot: AccountHoldingSnapshot[] } {
  let stockValue = 0;
  let latestDate: string | null = null;
  const snapshot: AccountHoldingSnapshot[] = [];
  for (const h of holdings) {
    const c = closesBySymbol.get(h.symbol) ?? null;
    const value = c ? h.shares * c.close : 0;
    stockValue += value;
    if (c?.date && (!latestDate || c.date > latestDate)) latestDate = c.date;
    snapshot.push({
      symbol: h.symbol,
      market: h.market,
      shares: h.shares,
      close: c?.close ?? null,
      closeDate: c?.date ?? null,
      value,
    });
  }
  return { stockValue, asOfDate: latestDate, holdingsSnapshot: snapshot };
}

/** 讀單檔 candles 拿最新一根 close (純 fs 操作) */
async function loadLatestClose(
  symbol: string,
  market: MarketId,
): Promise<{ close: number; date: string } | null> {
  const candlesPath = path.join(process.cwd(), 'data', 'candles', market, `${symbol}.json`);
  try {
    const raw = await fs.readFile(candlesPath, 'utf-8');
    const data = JSON.parse(raw) as { candles?: Array<{ date: string; close: number }> };
    const candles = data.candles ?? [];
    if (candles.length === 0) return null;
    const last = candles[candles.length - 1];
    return { close: last.close, date: last.date };
  } catch {
    return null;
  }
}

/** 從 holdings.json 重算 stockValue + 寫回 account.json（保留既有 cash）*/
export async function recalcStockValue(): Promise<AccountFile> {
  const holdings = await listOpenHoldings();
  const closes = new Map<string, { close: number; date: string } | null>();
  await Promise.all(
    holdings.map(async (h) => {
      const c = await loadLatestClose(h.symbol, h.market);
      closes.set(h.symbol, c);
    }),
  );
  const { stockValue, asOfDate, holdingsSnapshot } = computeStockValue(holdings, closes);
  const existing = await loadAccount();
  const file: AccountFile = {
    schemaVersion: ACCOUNT_SCHEMA_VERSION,
    cash: existing.cash,                       // 不動現金
    stockValue,
    totalCapital: existing.cash + stockValue,
    asOfDate,
    holdingsSnapshot,
    updatedAt: new Date().toISOString(),
  };
  await saveAccount(file);
  return file;
}

/** 手動更新 cash（其他欄位重算）*/
export async function updateCash(cash: number): Promise<AccountFile> {
  if (!Number.isFinite(cash) || cash < 0) throw new Error('cash 必須為非負數');
  const existing = await loadAccount();
  const file: AccountFile = {
    ...existing,
    cash,
    totalCapital: cash + existing.stockValue,
    updatedAt: new Date().toISOString(),
  };
  await saveAccount(file);
  return file;
}
