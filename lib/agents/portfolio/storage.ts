/**
 * Portfolio storage — holdings.json + reviews/{date}.json
 *
 * 採同 candidates/poolStorage 風格：純本地 FS + atomicFsPut
 */

import path from 'node:path';
import { promises as fs } from 'node:fs';
import { atomicFsPut } from '@/lib/storage/atomicFsPut';
import {
  PORTFOLIO_SCHEMA_VERSION,
  PortfolioFile,
  PortfolioHolding,
  PortfolioReviewFile,
} from './types';

const PORTFOLIO_DIR = path.join(process.cwd(), 'data', 'agents', 'portfolio');
const HOLDINGS_FILE = path.join(PORTFOLIO_DIR, 'holdings.json');

function reviewFilePath(date: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new Error(`unsafe date: ${date}`);
  }
  return path.join(PORTFOLIO_DIR, 'reviews', `${date}.json`);
}

// ────────────────────────────────────────────────────────────────────────────
// Holdings
// ────────────────────────────────────────────────────────────────────────────

export async function loadHoldings(): Promise<PortfolioFile> {
  try {
    const raw = await fs.readFile(HOLDINGS_FILE, 'utf-8');
    return JSON.parse(raw) as PortfolioFile;
  } catch {
    return {
      schemaVersion: PORTFOLIO_SCHEMA_VERSION,
      holdings: [],
      updatedAt: new Date().toISOString(),
    };
  }
}

export async function saveHoldings(file: PortfolioFile): Promise<void> {
  await fs.mkdir(PORTFOLIO_DIR, { recursive: true });
  file.updatedAt = new Date().toISOString();
  await atomicFsPut(HOLDINGS_FILE, JSON.stringify(file, null, 2));
}

/**
 * 新增/更新持股（by symbol）
 * 同 symbol 已存在 → 更新；否則新增
 */
export async function upsertHolding(holding: Omit<PortfolioHolding, 'createdAt' | 'updatedAt' | 'schemaVersion'>): Promise<PortfolioHolding> {
  const file = await loadHoldings();
  const now = new Date().toISOString();
  const existingIdx = file.holdings.findIndex(h => h.symbol === holding.symbol && h.status === 'open');
  let result: PortfolioHolding;
  if (existingIdx >= 0) {
    result = {
      ...file.holdings[existingIdx],
      ...holding,
      schemaVersion: PORTFOLIO_SCHEMA_VERSION,
      updatedAt: now,
    };
    file.holdings[existingIdx] = result;
  } else {
    result = {
      schemaVersion: PORTFOLIO_SCHEMA_VERSION,
      ...holding,
      createdAt: now,
      updatedAt: now,
    };
    file.holdings.push(result);
  }
  await saveHoldings(file);
  return result;
}

/** 關閉持股（標 closed + 記錄出場資訊）*/
export async function closeHolding(
  symbol: string,
  args: { closedPrice: number; closeReason: string; closedAt?: string },
): Promise<PortfolioHolding | null> {
  const file = await loadHoldings();
  const idx = file.holdings.findIndex(h => h.symbol === symbol && h.status === 'open');
  if (idx < 0) return null;
  const h = file.holdings[idx];
  h.status = 'closed';
  h.closedAt = args.closedAt ?? new Date().toISOString();
  h.closedPrice = args.closedPrice;
  h.closeReason = args.closeReason;
  h.updatedAt = new Date().toISOString();
  await saveHoldings(file);
  return h;
}

/** 刪除持股（硬刪，不留 audit trail — 慎用）*/
export async function deleteHolding(symbol: string): Promise<boolean> {
  const file = await loadHoldings();
  const before = file.holdings.length;
  file.holdings = file.holdings.filter(h => h.symbol !== symbol);
  if (file.holdings.length === before) return false;
  await saveHoldings(file);
  return true;
}

export async function listOpenHoldings(): Promise<PortfolioHolding[]> {
  const file = await loadHoldings();
  return file.holdings.filter(h => h.status === 'open');
}

// ────────────────────────────────────────────────────────────────────────────
// Daily reviews
// ────────────────────────────────────────────────────────────────────────────

export async function loadReview(date: string): Promise<PortfolioReviewFile | null> {
  try {
    const raw = await fs.readFile(reviewFilePath(date), 'utf-8');
    return JSON.parse(raw) as PortfolioReviewFile;
  } catch {
    return null;
  }
}

export async function saveReview(review: PortfolioReviewFile): Promise<string> {
  const file = reviewFilePath(review.date);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await atomicFsPut(file, JSON.stringify(review, null, 2));
  return file;
}
