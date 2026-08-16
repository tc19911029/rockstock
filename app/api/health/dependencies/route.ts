import { promises as fs } from 'fs';
import path from 'path';
import { apiOk } from '@/lib/api/response';
import {
  fetchFinMindBranchDay,
  getFinMindBranchSourceStatus,
} from '@/lib/datasource/FinMindBranchProvider';
import { getLastTradingDay } from '@/lib/datasource/marketHours';
import { assessPaperTrackFreshness } from '@/lib/health/paperTrackFreshness';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

export async function GET() {
  // 用一檔高流動性股票探測 FinMind 權限。provider 內有 15 分鐘永久錯誤短路，
  // 健康頁每分鐘刷新也不會反覆打外部 API。
  await fetchFinMindBranchDay('2330', getLastTradingDay('TW')).catch(() => new Map());
  const finMind = getFinMindBranchSourceStatus();

  let paperUpdatedAt: string | null = null;
  try {
    const raw = await fs.readFile(path.join(process.cwd(), 'data', 'paper-trades.json'), 'utf8');
    paperUpdatedAt = (JSON.parse(raw) as { updatedAt?: string }).updatedAt ?? null;
  } catch { /* 由 freshness 回 missing */ }
  const paper = assessPaperTrackFreshness(paperUpdatedAt);

  return apiOk({
    checkedAt: new Date().toISOString(),
    dependencies: {
      finMindBranch: finMind,
      paperTrack: { ...paper, updatedAt: paperUpdatedAt },
    },
  });
}
