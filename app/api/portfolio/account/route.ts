/**
 * /api/portfolio/account — 帳戶總資金 CRUD
 *
 *   GET                       讀 account.json
 *   POST { cash }             更新 cash（保留 stockValue）
 *   POST { recalc: true }     重算 stockValue（讀 holdings × 最新 K 線 close）
 */

import { NextRequest } from 'next/server';
import { z } from 'zod';
import { apiOk, apiError, apiValidationError } from '@/lib/api/response';
import { loadAccount, updateCash, recalcStockValue } from '@/lib/portfolio/account';

export const runtime = 'nodejs';

const postSchema = z.union([
  z.object({ cash: z.coerce.number().nonnegative() }),
  z.object({ recalc: z.literal(true) }),
]);

export async function GET() {
  const account = await loadAccount();
  return apiOk({ account });
}

export async function POST(req: NextRequest) {
  let body: unknown;
  try { body = await req.json(); } catch { return apiError('invalid JSON body', 400); }
  const parsed = postSchema.safeParse(body);
  if (!parsed.success) return apiValidationError(parsed.error);

  if ('cash' in parsed.data) {
    const account = await updateCash(parsed.data.cash);
    return apiOk({ account, action: 'updateCash' });
  }
  // recalc
  const account = await recalcStockValue();
  return apiOk({ account, action: 'recalc' });
}
