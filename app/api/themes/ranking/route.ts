/**
 * TWSE／TPEx 官方產業強弱排名查詢（附描述性輪動標籤）
 * GET /api/themes/ranking[?date=YYYY-MM-DD]
 * 不帶 date：回最近 7 天內最新一份；帶 date：回該日（無檔 404）。
 * 附 rotation（每題材 今日漲幅名次 vs 昨天 + 🟢🟡🔴 桶）— 純描述非訊號。
 */
import { NextRequest } from 'next/server';
import { apiOk, apiError } from '@/lib/api/response';
import { buildSectorRanking, readSectorRanking, readLatestSectorRanking, listSectorDates } from '@/lib/themes/sectorRanking';
import { computeRotation } from '@/lib/themes/themeRotation';

export const runtime = 'nodejs';

const ROTATION_LOOKBACK = 1; // 前一交易日（昨天）— 2026-06-19 改日線，原本 5 反應太慢

export async function GET(req: NextRequest) {
  const date = req.nextUrl.searchParams.get('date');
  let file = date ? await readSectorRanking(date) : await readLatestSectorRanking();
  if (!file) {
    // 舊的手工題材檔會被 readSectorRanking 拒絕；第一次部署時即時重算，毋須等隔日 cron。
    const dates = await listSectorDates();
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Taipei' }).format(new Date());
    const buildDate = date ?? dates.at(-1) ?? today;
    try {
      file = await buildSectorRanking(buildDate);
    } catch (error) {
      return apiError(error instanceof Error ? error.message : 'official industry ranking unavailable', 503);
    }
  }

  // 找前一交易日的檔，算日輪動（資料不足則 rotation 為 mid/null，UI 自會淡化）
  let priorDate: string | null = null;
  const dates = await listSectorDates();
  const idx = dates.indexOf(file.date);
  if (idx >= 0) priorDate = dates[Math.max(0, idx - ROTATION_LOOKBACK)];
  const prior = priorDate && priorDate !== file.date ? await readSectorRanking(priorDate) : null;
  const rotation = computeRotation(file, prior);

  const themes = file.themes.map((t) => ({ ...t, rotation: rotation.get(t.theme) ?? null }));
  return apiOk({ ...file, priorDate, themes });
}
