/**
 * GET /api/agents/memory               → 列出所有 memory 檔 metadata
 * GET /api/agents/memory?kind=...      → 讀某類 markdown 內容
 * GET /api/agents/memory?kind=weekly&week=2026-W21 → 讀某週
 *
 * 純讀，不寫 — memory 寫入只有 reflect skill 走檔案系統直接寫
 */

import { NextRequest } from 'next/server';
import { z } from 'zod';
import { apiOk, apiError, apiValidationError } from '@/lib/api/response';
import { listMemoryFiles, readMemory } from '@/lib/agents/memory/storage';
import { MEMORY_KINDS, MemoryKind } from '@/lib/agents/memory/types';

export const runtime = 'nodejs';

const querySchema = z.object({
  kind: z.enum(MEMORY_KINDS as [MemoryKind, ...MemoryKind[]]).optional(),
  week: z.string().regex(/^\d{4}-W\d{2}$/).optional(),
});

export async function GET(req: NextRequest) {
  const parsed = querySchema.safeParse(Object.fromEntries(new URL(req.url).searchParams));
  if (!parsed.success) return apiValidationError(parsed.error);
  const { kind, week } = parsed.data;

  if (!kind) {
    const files = await listMemoryFiles();
    return apiOk({ mode: 'list', files });
  }

  if (kind === 'weekly' && !week) {
    return apiError('weekly mode 需 ?week=YYYY-Www', 400);
  }

  const content = await readMemory(kind, week);
  return apiOk({
    mode: 'single',
    kind,
    week: week ?? null,
    exists: content !== null,
    content,
  });
}
