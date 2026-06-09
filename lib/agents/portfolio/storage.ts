/**
 * Portfolio storage — holdings.json + reviews/{date}.json
 *
 * 採同 candidates/poolStorage 風格：純本地 FS + atomicFsPut
 */

import path from 'node:path';
import { promises as fs } from 'node:fs';
import { atomicFsPut } from '@/lib/storage/atomicFsPut';
import type { MarketId } from '@/lib/scanner/types';
import { classifyMarket } from '@/lib/market/classify';
import { profileDir, DEFAULT_PROFILE_ID } from '@/lib/portfolio/profiles';
import {
  PORTFOLIO_SCHEMA_VERSION,
  PortfolioFile,
  PortfolioHolding,
  PortfolioReviewFile,
} from './types';

const PORTFOLIO_DIR = path.join(process.cwd(), 'data', 'agents', 'portfolio');
const HOLDINGS_FILE = path.join(PORTFOLIO_DIR, 'holdings.json');

/**
 * 陸股持倉與台股**完全分檔**（用戶 2026-05-29 決議「陸股跟台股要分開記」）。
 *
 * 鐵則：陸股檔放 data/portfolio/holdings-cn.json，**不**放 data/agents/portfolio/，
 * 確保 listOpenHoldings()（TW-only：sizer / growthPath / 月報 讀）永遠只看台股檔。
 */
const CN_HOLDINGS_FILE = path.join(process.cwd(), 'data', 'portfolio', 'holdings-cn.json');

/**
 * 依市場 + profile 挑持倉檔。
 * - 預設 profile 'me' → 既有 legacy 路徑（CN → holdings-cn.json；其餘 → holdings.json）。
 * - 其他 profile → data/portfolios/{id}/holdings(-cn).json（與「我的」完全隔離）。
 */
function holdingsFileFor(market: MarketId, profileId: string = DEFAULT_PROFILE_ID): string {
  const dir = profileDir(profileId);
  if (dir) {
    return path.join(dir, market === 'CN' ? 'holdings-cn.json' : 'holdings.json');
  }
  return market === 'CN' ? CN_HOLDINGS_FILE : HOLDINGS_FILE;
}

function reviewFilePath(date: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new Error(`unsafe date: ${date}`);
  }
  return path.join(PORTFOLIO_DIR, 'reviews', `${date}.json`);
}

// ────────────────────────────────────────────────────────────────────────────
// Holdings
// ────────────────────────────────────────────────────────────────────────────

export async function loadHoldings(market: MarketId = 'TW', profileId: string = DEFAULT_PROFILE_ID): Promise<PortfolioFile> {
  try {
    const raw = await fs.readFile(holdingsFileFor(market, profileId), 'utf-8');
    return JSON.parse(raw) as PortfolioFile;
  } catch {
    return {
      schemaVersion: PORTFOLIO_SCHEMA_VERSION,
      holdings: [],
      updatedAt: new Date().toISOString(),
    };
  }
}

export async function saveHoldings(file: PortfolioFile, market: MarketId = 'TW', profileId: string = DEFAULT_PROFILE_ID): Promise<void> {
  const target = holdingsFileFor(market, profileId);
  await fs.mkdir(path.dirname(target), { recursive: true });
  file.updatedAt = new Date().toISOString();
  await atomicFsPut(target, JSON.stringify(file, null, 2));
}

/** 讀台股+陸股全部持倉（合併，給 UI hydration 用）*/
export async function loadAllHoldings(profileId: string = DEFAULT_PROFILE_ID): Promise<PortfolioHolding[]> {
  const [tw, cn] = await Promise.all([loadHoldings('TW', profileId), loadHoldings('CN', profileId)]);
  return [...tw.holdings, ...cn.holdings];
}

/**
 * 新增/更新持股（by symbol）
 * 同 symbol 已存在 → 更新；否則新增
 * market 由 holding.market 決定要寫哪個檔（CN → holdings-cn.json）
 */
export async function upsertHolding(
  holding: Omit<PortfolioHolding, 'createdAt' | 'updatedAt' | 'schemaVersion'>,
  profileId: string = DEFAULT_PROFILE_ID,
): Promise<PortfolioHolding> {
  const market = holding.market;
  const file = await loadHoldings(market, profileId);
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
  await saveHoldings(file, market, profileId);
  return result;
}

/** symbol 後綴推市場（.SS/.SZ → CN；其餘 → TW）*/
function marketOfSymbol(symbol: string): MarketId {
  return classifyMarket(symbol) === 'CN' ? 'CN' : 'TW';
}

/** 關閉持股（標 closed + 記錄出場資訊）*/
export async function closeHolding(
  symbol: string,
  args: { closedPrice: number; closeReason: string; closedAt?: string },
  profileId: string = DEFAULT_PROFILE_ID,
): Promise<PortfolioHolding | null> {
  const market = marketOfSymbol(symbol);
  const file = await loadHoldings(market, profileId);
  const idx = file.holdings.findIndex(h => h.symbol === symbol && h.status === 'open');
  if (idx < 0) return null;
  const h = file.holdings[idx];
  h.status = 'closed';
  h.closedAt = args.closedAt ?? new Date().toISOString();
  h.closedPrice = args.closedPrice;
  h.closeReason = args.closeReason;
  h.updatedAt = new Date().toISOString();
  await saveHoldings(file, market, profileId);
  return h;
}

/** 刪除持股（硬刪，不留 audit trail — 慎用）*/
export async function deleteHolding(symbol: string, profileId: string = DEFAULT_PROFILE_ID): Promise<boolean> {
  const market = marketOfSymbol(symbol);
  const file = await loadHoldings(market, profileId);
  const before = file.holdings.length;
  file.holdings = file.holdings.filter(h => h.symbol !== symbol);
  if (file.holdings.length === before) return false;
  await saveHoldings(file, market, profileId);
  return true;
}

export async function listOpenHoldings(profileId: string = DEFAULT_PROFILE_ID): Promise<PortfolioHolding[]> {
  const file = await loadHoldings('TW', profileId);
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
