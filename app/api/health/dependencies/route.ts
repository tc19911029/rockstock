import { promises as fs } from 'fs';
import path from 'path';
import { apiOk } from '@/lib/api/response';
import {
  fetchFinMindBranchDay,
  getFinMindBranchSourceStatus,
} from '@/lib/datasource/FinMindBranchProvider';
import { getLastTradingDay } from '@/lib/datasource/marketHours';
import { assessPaperTrackFreshness } from '@/lib/health/paperTrackFreshness';
import { summarizeDataSourceResilience } from '@/lib/datasource/DataSourceResilience';
import { getChipCoverageSnapshot } from '@/lib/health/chipCoverage';
import { assessYTrackReadiness } from '@/lib/chips/yTrackReadiness';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

export async function GET() {
  const date = getLastTradingDay('TW');
  // 用一檔高流動性股票探測 FinMind 權限。provider 內有 15 分鐘永久錯誤短路，
  // 健康頁每分鐘刷新也不會反覆打外部 API。
  const noFinmind = process.env.INSTSTEAL_NO_FINMIND === '1';
  if (!noFinmind) await fetchFinMindBranchDay('2330', date).catch(() => new Map());
  const finMind = noFinmind
    ? { kind: 'unavailable' as const, message: '精確全分點來源已停用；目前使用 Yahoo 每日前 15 大近似模式', checkedAt: new Date().toISOString() }
    : getFinMindBranchSourceStatus();
  const [chipCoverage, yTrackReadiness] = await Promise.all([
    getChipCoverageSnapshot(date),
    assessYTrackReadiness(date),
  ]);

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
      chipCoverage,
      yTrackReadiness,
      paperTrack: { ...paper, updatedAt: paperUpdatedAt },
      dataSourceResilience: summarizeDataSourceResilience(),
    },
  });
}
