import { NextRequest } from 'next/server';
import { z } from 'zod';
import { loadDabanSession, listDabanDates } from '@/lib/storage/dabanStorage';
import { apiOk, apiError, apiValidationError } from '@/lib/api/response';

export const runtime = 'nodejs';

const querySchema = z.object({
  date: z.string().optional(),
});

export async function GET(req: NextRequest) {
  const parsed = querySchema.safeParse(Object.fromEntries(new URL(req.url).searchParams));
  if (!parsed.success) return apiValidationError(parsed.error);

  try {
    if (parsed.data.date) {
      const session = await loadDabanSession(parsed.data.date);
      if (!session) return apiOk({ session: null });
      return apiOk({ session });
    }

    const dates = await listDabanDates();
    return apiOk({ dates });
  } catch (err: unknown) {
    console.error('[scanner/daban] error:', err);
    return apiError('打板掃描服務暫時無法使用');
  }
}
