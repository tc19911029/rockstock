/**
 * /api/portfolio/profiles — 多人持倉「檔案」(profile) 管理
 *
 * GET    列出所有 profile（含預設「我的」me）
 * POST   { name }       新增 profile，回傳含 id
 * PATCH  { id, name }   重新命名
 * DELETE ?id=           刪除（擋刪 me；連同 data/portfolios/{id}/ 整夾移除）
 *
 * profile = 一組獨立持倉檔案（holdings / trades）。預設 'me' 沿用既有路徑、零搬遷。
 */

import { NextRequest } from 'next/server';
import { z } from 'zod';
import { apiOk, apiError, apiValidationError } from '@/lib/api/response';
import {
  loadProfiles,
  createProfile,
  renameProfile,
  deleteProfile,
  isValidProfileId,
} from '@/lib/portfolio/profiles';

export const runtime = 'nodejs';

export async function GET() {
  const file = await loadProfiles();
  return apiOk({ profiles: file.profiles });
}

const createSchema = z.object({ name: z.string().min(1).max(20) });

export async function POST(req: NextRequest) {
  let body: unknown;
  try { body = await req.json(); } catch { return apiError('invalid JSON body', 400); }
  const parsed = createSchema.safeParse(body);
  if (!parsed.success) return apiValidationError(parsed.error);
  try {
    const profile = await createProfile(parsed.data.name);
    return apiOk({ profile });
  } catch (e) {
    return apiError(e instanceof Error ? e.message : String(e), 400);
  }
}

const renameSchema = z.object({ id: z.string(), name: z.string().min(1).max(20) });

export async function PATCH(req: NextRequest) {
  let body: unknown;
  try { body = await req.json(); } catch { return apiError('invalid JSON body', 400); }
  const parsed = renameSchema.safeParse(body);
  if (!parsed.success) return apiValidationError(parsed.error);
  if (!isValidProfileId(parsed.data.id)) return apiError('invalid profile id', 400);
  try {
    const profile = await renameProfile(parsed.data.id, parsed.data.name);
    return apiOk({ profile });
  } catch (e) {
    return apiError(e instanceof Error ? e.message : String(e), 404);
  }
}

export async function DELETE(req: NextRequest) {
  const id = new URL(req.url).searchParams.get('id') ?? '';
  if (!isValidProfileId(id)) return apiError('invalid profile id', 400);
  try {
    const ok = await deleteProfile(id);
    if (!ok) return apiError(`profile ${id} not found`, 404);
    return apiOk({ deleted: true });
  } catch (e) {
    return apiError(e instanceof Error ? e.message : String(e), 400);
  }
}
