/**
 * /api/portfolio/import — 批量匯入持股
 *
 * POST body 兩種型式擇一：
 *   { "csv": "symbol,name,shares,avgCost\n3037.TW,欣興,30,856.5", "forcePrice": false }
 *   { "rows": [{ symbol, name, shares, avgCost, ... }], "forcePrice": false }
 *
 * 回傳：
 *   { results: [{ rowNumber, symbol, status: 'inserted'|'rejected', reason? }] }
 *
 * 設計重點：
 *   - 每 row 獨立驗證、互不擋
 *   - entryPrice 驗證走 lib/agents/portfolio/validateEntryPrice.ts（共用 Phase 0.1 邏輯）
 *   - forcePrice=true 略過 entryPrice 驗證（少數合理 case）
 *   - 不刪除既有 holdings（idempotent upsert by symbol）
 */

import { NextRequest } from 'next/server';
import { z } from 'zod';
import { apiOk, apiError, apiValidationError } from '@/lib/api/response';
import { checkSameOriginOrCron } from '@/lib/api/sameOriginAuth';
import { upsertHolding } from '@/lib/agents/portfolio/storage';
import { resolveProfileId } from '@/lib/portfolio/profiles';
import { validateEntryPrice } from '@/lib/agents/portfolio/validateEntryPrice';
import {
  parseImportCsv,
  parseRow,
  applyDefaults,
  type ParsedImportRow,
} from '@/lib/portfolio/holdingsImport';

export const runtime = 'nodejs';

const rowSchema = z.object({
  symbol: z.string().regex(/^[A-Za-z0-9._-]+$/),
  name: z.string().min(1),
  shares: z.coerce.number().int().positive(),
  avgCost: z.coerce.number().positive(),
  entryDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  stopLoss: z.coerce.number().positive().optional(),
  target1: z.coerce.number().positive().optional(),
  target2: z.coerce.number().positive().optional(),
  industry: z.string().optional(),
  notes: z.string().optional(),
});

const bodySchema = z.object({
  csv: z.string().optional(),
  rows: z.array(rowSchema).optional(),
  forcePrice: z.coerce.boolean().optional().default(false),
}).refine(d => d.csv || d.rows, { message: 'either csv or rows required' });

interface RowResult {
  rowNumber: number;
  symbol?: string;
  status: 'inserted' | 'rejected';
  reason?: string;
}

function todayCstDate(): string {
  // Asia/Taipei 是 UTC+8，固定 offset
  const now = new Date();
  const tw = new Date(now.getTime() + 8 * 3600 * 1000);
  return tw.toISOString().slice(0, 10);
}

export async function POST(req: NextRequest) {
  const denied = checkSameOriginOrCron(req);
  if (denied) return denied;

  let body: unknown;
  try { body = await req.json(); } catch { return apiError('invalid JSON body', 400); }
  const parsed = bodySchema.safeParse(body);
  if (!parsed.success) return apiValidationError(parsed.error);

  const { csv, rows: jsonRows, forcePrice } = parsed.data;
  const profileId = resolveProfileId(new URL(req.url).searchParams.get('profile'));
  const today = todayCstDate();
  const results: RowResult[] = [];

  // 路徑 1：CSV 字串
  let parsedRows: ParsedImportRow[] = [];
  if (csv) {
    const r = parseImportCsv(csv);
    if (!r.ok) return apiError(`CSV 解析失敗：${r.reason}`, 400);
    parsedRows = r.parsed;
  }

  // 路徑 2：JSON rows
  if (jsonRows) {
    parsedRows = jsonRows.map((r, idx) =>
      parseRow(
        Object.fromEntries(Object.entries(r).map(([k, v]) => [k, v == null ? '' : String(v)])),
        idx + 1,
      ),
    );
  }

  // 逐 row 驗證 + upsert
  for (const p of parsedRows) {
    if (!p.ok || !p.row) {
      results.push({ rowNumber: p.rowNumber, symbol: p.raw.symbol, status: 'rejected', reason: p.reason });
      continue;
    }

    let holdingData: ReturnType<typeof applyDefaults>;
    try {
      holdingData = applyDefaults(p.row, today);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      results.push({ rowNumber: p.rowNumber, symbol: p.row.symbol, status: 'rejected', reason: msg });
      continue;
    }

    // entryPrice 合理性檢查
    if (!forcePrice) {
      const check = await validateEntryPrice(
        holdingData.symbol,
        holdingData.market,
        holdingData.entryDate,
        holdingData.entryPrice,
      );
      if (!check.ok) {
        results.push({ rowNumber: p.rowNumber, symbol: p.row.symbol, status: 'rejected', reason: check.reason });
        continue;
      }
    }

    try {
      await upsertHolding(holdingData, profileId);
      results.push({ rowNumber: p.rowNumber, symbol: p.row.symbol, status: 'inserted' });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      results.push({ rowNumber: p.rowNumber, symbol: p.row.symbol, status: 'rejected', reason: msg });
    }
  }

  const inserted = results.filter(r => r.status === 'inserted').length;
  const rejected = results.filter(r => r.status === 'rejected').length;
  return apiOk({
    inserted,
    rejected,
    total: results.length,
    results,
  });
}
