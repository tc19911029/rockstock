import { NextRequest } from 'next/server';
import { apiOk, apiError } from '@/lib/api/response';
import { checkCronAuth } from '@/lib/api/cronAuth';
import { fetchLhbBoard } from '@/lib/cn-agents/datasource/emDragonTigerDaily';
import { buildSeatStats } from '@/lib/cn-agents/seatStats';
import { loadSeatRegistry } from '@/lib/cn-agents/seats';
import { listLhbDates, readLhbDaily, saveLhbDaily, saveSeatStats } from '@/lib/cn-agents/storage';

export const runtime = 'nodejs';
export const maxDuration = 300;

/**
 * 席位績效統計 cron（20:10 CST，在 19:30 lhb 抓取之後）：
 *   step 1 — 回補近 ?fwdBackfillDays=5 個有檔日的 fwd 欄
 *            （EM 榜面 D1/D5/D10_CLOSE_ADJCHRATE 事後才填值；只 merge fwd 不動席位明細）
 *   step 2 — 全部 lhb 日檔 → buildSeatStats 全量重建 → seats/stats.json
 */
export async function GET(req: NextRequest) {
  const denied = checkCronAuth(req);
  if (denied) return denied;

  const nRaw = parseInt(req.nextUrl.searchParams.get('fwdBackfillDays') ?? '5', 10);
  const fwdDays = Math.min(30, Math.max(0, Number.isFinite(nRaw) ? nRaw : 5));

  try {
    const dates = await listLhbDates();

    // step 1：fwd 回補（最後一日是當日、fwd 必空，跳過省一發）
    let fwdUpdated = 0;
    for (const date of dates.slice(-fwdDays - 1, -1)) {
      const file = await readLhbDaily(date);
      if (!file) continue;
      const needs = file.stocks.some((s) => s.fwd.d1 === null || s.fwd.d5 === null || s.fwd.d10 === null);
      if (!needs) continue;
      try {
        const rows = await fetchLhbBoard(date);
        const fwdByKey = new Map<string, { d1: number | null; d2: number | null; d5: number | null; d10: number | null }>();
        for (const r of rows) {
          const code = String(r.SECURITY_CODE ?? '');
          const reason = String(r.EXPLANATION ?? '');
          const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
          fwdByKey.set(`${code} ${reason}`, {
            d1: num(r.D1_CLOSE_ADJCHRATE),
            d2: num(r.D2_CLOSE_ADJCHRATE),
            d5: num(r.D5_CLOSE_ADJCHRATE),
            d10: num(r.D10_CLOSE_ADJCHRATE),
          });
        }
        let changed = false;
        for (const s of file.stocks) {
          const fwd = fwdByKey.get(`${s.code} ${s.reason}`);
          if (!fwd) continue;
          if (
            fwd.d1 !== s.fwd.d1 || fwd.d2 !== s.fwd.d2 ||
            fwd.d5 !== s.fwd.d5 || fwd.d10 !== s.fwd.d10
          ) {
            s.fwd = fwd;
            changed = true;
          }
        }
        if (changed) {
          await saveLhbDaily(file);
          fwdUpdated++;
        }
      } catch { /* 單日回補失敗不擋重建 */ }
    }

    // step 2：全量重建席位統計
    const files = (await Promise.all(dates.map((d) => readLhbDaily(d)))).filter(
      (f): f is NonNullable<typeof f> => f !== null,
    );
    const registry = await loadSeatRegistry();

    // 行業對照：主板走 cn_stocklist；成長板上過漲停池的用池檔 industry 補
    const industryBySymbol = new Map<string, string>();
    try {
      const path = await import('path');
      const { promises: fs } = await import('fs');
      const raw = JSON.parse(
        await fs.readFile(path.join(process.cwd(), 'data', 'cn_stocklist.json'), 'utf-8'),
      ) as Array<{ symbol: string; industry?: string | null }>;
      for (const r of raw) {
        if (r.industry) industryBySymbol.set(r.symbol.split('.')[0], r.industry);
      }
    } catch { /* 清單缺 → topIndustries 略空，可容忍 */ }

    const stats = buildSeatStats(files, registry, industryBySymbol);
    await saveSeatStats(stats);

    return apiOk({
      ok: true,
      lhbDates: dates.length,
      fwdUpdated,
      seats: stats.seats.length,
      windowFrom: stats.windowFrom,
      windowTo: stats.windowTo,
    });
  } catch (err) {
    return apiError(err instanceof Error ? err.message : '席位統計 cron 失敗', 500);
  }
}
