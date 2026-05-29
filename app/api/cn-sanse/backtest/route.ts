import { promises as fs } from 'fs';
import path from 'path';
import { apiOk, apiError } from '@/lib/api/response';
import { runResonanceBacktest, type ResonanceBacktest } from '@/lib/cn-sanse/backtestResonance';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

// 優先回傳全期深度結果（scripts/backtest-cn-sanse-rerank.ts 固化），無則即時算 30 天版。
let cache: { result: ResonanceBacktest; at: number } | null = null;
const TTL_MS = 30 * 60 * 1000;

async function readDeepStats(): Promise<ResonanceBacktest | null> {
  try {
    const raw = await fs.readFile(path.join(process.cwd(), 'data', 'cn-sanse', 'bucket-stats.json'), 'utf8');
    const j = JSON.parse(raw) as ResonanceBacktest;
    return Array.isArray(j.buckets) ? j : null;
  } catch {
    return null;
  }
}

export async function GET(req: Request) {
  const force = new URL(req.url).searchParams.get('force') === '1';
  try {
    // force=1 → 即時重算 30 天版（深度版要跑腳本）；否則優先用深度固化結果
    if (!force) {
      const deep = await readDeepStats();
      if (deep) return apiOk({ ...deep, cached: true, source: 'deep' });
      if (cache && Date.now() - cache.at < TTL_MS) {
        return apiOk({ ...cache.result, cached: true, source: 'live30' });
      }
    }
    const result = await runResonanceBacktest();
    cache = { result, at: Date.now() };
    return apiOk({ ...result, cached: false, source: 'live30' });
  } catch (e) {
    return apiError(e instanceof Error ? e.message : '回測失敗', 500);
  }
}
