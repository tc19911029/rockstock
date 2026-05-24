/**
 * /api/portfolio/trade-journal
 *
 * GET  → 列所有已平倉交易 join 對應的 journal entry（含 annotations）
 * POST → upsert 一筆 journal entry，body: { tradeId, entryReason?, exitRule?, postMortem?, lessons?, executionScore? }
 *
 * trades.json 本身不動（append-only），annotations 走 trade-journal.json overlay。
 */

import { NextRequest } from 'next/server';
import { z } from 'zod';
import { apiOk, apiError, apiValidationError } from '@/lib/api/response';
import { loadTrades } from '@/lib/portfolio/tradeRecorder';
import { loadJournal, upsertJournalEntry } from '@/lib/portfolio/tradeJournal';

export const runtime = 'nodejs';

export async function GET() {
  const [trades, journal] = await Promise.all([loadTrades(), loadJournal()]);
  // join：每筆 trade 帶上對應的 journal entry（沒寫過的就 null）
  const items = trades.trades.map(t => ({
    trade: t,
    journal: journal.entries[t.tradeId] ?? null,
  }));
  // 排序：最新出場日在前
  items.sort((a, b) => b.trade.exitDate.localeCompare(a.trade.exitDate));
  return apiOk({ items, count: items.length });
}

const postSchema = z.object({
  tradeId: z.string().min(1),
  entryReason: z.string().optional(),
  exitRule: z.string().optional(),
  postMortem: z.string().optional(),
  lessons: z.array(z.string()).optional(),
  executionScore: z.number().int().min(1).max(5).optional(),
});

export async function POST(req: NextRequest) {
  let body: unknown;
  try { body = await req.json(); } catch { return apiError('invalid JSON', 400); }
  const parsed = postSchema.safeParse(body);
  if (!parsed.success) return apiValidationError(parsed.error);
  const { tradeId, ...patch } = parsed.data;
  const entry = await upsertJournalEntry(tradeId, patch);
  return apiOk({ entry });
}
