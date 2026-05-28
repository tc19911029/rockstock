import { apiOk, apiError } from '@/lib/api/response';
import { runResonanceBacktest, type ResonanceBacktest } from '@/lib/cn-sanse/backtestResonance';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 120;

// 歷史掃描日靜態 → 算一次快取（?force=1 重算）
let cache: { result: ResonanceBacktest; at: number } | null = null;
const TTL_MS = 30 * 60 * 1000;

export async function GET(req: Request) {
  const force = new URL(req.url).searchParams.get('force') === '1';
  try {
    if (!force && cache && Date.now() - cache.at < TTL_MS) {
      return apiOk({ ...cache.result, cached: true });
    }
    const result = await runResonanceBacktest();
    cache = { result, at: Date.now() };
    return apiOk({ ...result, cached: false });
  } catch (e) {
    return apiError(e instanceof Error ? e.message : '回測失敗', 500);
  }
}
