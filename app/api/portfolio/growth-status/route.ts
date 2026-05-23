/**
 * /api/portfolio/growth-status — 資金成長路徑進度
 *
 *   GET                             讀路徑 + 即時算 currentCapital + 回 progress
 *   GET ?asOfDate=YYYY-MM-DD        指定 asOfDate（預設今日 CST）
 *   POST { regen: true, ... }       重算路徑（startCapital/targetCapital/targetDate/warningBands）
 *
 * 當前資金計算：
 *   - 讀 holdings.json open holdings（TW-only，與「不要管陸股」決議一致）
 *   - 每檔讀 data/candles/TW/{symbol}.json 最新 close
 *   - currentStockValue = Σ shares × close
 *   - currentCapital = cash (from account.json) + currentStockValue
 *
 * 路徑不存在時：
 *   - GET 回 404 + 提示先 POST regen
 *   - 也可選用 query autoStart=true 自動以 currentCapital 為 start 重建
 */

import { NextRequest } from 'next/server';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { z } from 'zod';
import { apiOk, apiError, apiValidationError } from '@/lib/api/response';
import {
  loadGrowthPath, regenGrowthPath, computeProgress, type GrowthPathFile,
} from '@/lib/portfolio/growthPath';
import { listOpenHoldings } from '@/lib/agents/portfolio/storage';
import { loadAccount } from '@/lib/portfolio/account';
import type { MarketId } from '@/lib/scanner/types';

export const runtime = 'nodejs';

function todayCst(): string {
  const tw = new Date(Date.now() + 8 * 3600 * 1000);
  return tw.toISOString().slice(0, 10);
}

async function loadLatestClose(symbol: string, market: MarketId): Promise<number | null> {
  const candlesPath = path.join(process.cwd(), 'data', 'candles', market, `${symbol}.json`);
  try {
    const raw = await fs.readFile(candlesPath, 'utf-8');
    const data = JSON.parse(raw) as { candles?: Array<{ close: number }> };
    const c = data.candles ?? [];
    return c.length > 0 ? c[c.length - 1].close : null;
  } catch { return null; }
}

async function computeCurrentCapital(): Promise<{ cash: number; stockValue: number; total: number; holdingsCount: number }> {
  const account = await loadAccount();
  const cash = account.cash;
  const holdings = await listOpenHoldings();
  const twHoldings = holdings.filter(h => h.market === 'TW');
  let stockValue = 0;
  await Promise.all(twHoldings.map(async (h) => {
    const close = await loadLatestClose(h.symbol, 'TW');
    if (close != null) stockValue += h.shares * close;
  }));
  return { cash, stockValue, total: cash + stockValue, holdingsCount: twHoldings.length };
}

const getQuerySchema = z.object({
  asOfDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
});

const postSchema = z.object({
  regen: z.literal(true),
  startCapital: z.coerce.number().positive(),
  targetCapital: z.coerce.number().positive(),
  targetDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  warningYellow: z.coerce.number().lt(0).optional(),
  warningRed: z.coerce.number().lt(0).optional(),
  notes: z.string().optional(),
});

export async function GET(req: NextRequest) {
  const parsed = getQuerySchema.safeParse(Object.fromEntries(new URL(req.url).searchParams));
  if (!parsed.success) return apiValidationError(parsed.error);
  const asOfDate = parsed.data.asOfDate ?? todayCst();

  const pathFile = await loadGrowthPath();
  if (!pathFile) {
    return apiError(
      'growth-path.json 不存在；先 POST { regen: true, startCapital, targetCapital, targetDate }',
      404,
    );
  }

  const capital = await computeCurrentCapital();
  const progress = computeProgress(pathFile, asOfDate, capital.total);

  return apiOk({
    path: pathFile,
    asOfDate,
    capital,
    progress,
  });
}

export async function POST(req: NextRequest) {
  let body: unknown;
  try { body = await req.json(); } catch { return apiError('invalid JSON body', 400); }
  const parsed = postSchema.safeParse(body);
  if (!parsed.success) return apiValidationError(parsed.error);
  const d = parsed.data;
  const warningBands = (d.warningYellow != null || d.warningRed != null)
    ? { yellowPct: d.warningYellow ?? -0.05, redPct: d.warningRed ?? -0.10 }
    : undefined;
  const file: GrowthPathFile = await regenGrowthPath({
    startDate: d.startDate ?? todayCst(),
    startCapital: d.startCapital,
    targetCapital: d.targetCapital,
    targetDate: d.targetDate,
    warningBands,
    notes: d.notes,
  });
  return apiOk({ path: file });
}
