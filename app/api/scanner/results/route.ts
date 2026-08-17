import { NextRequest } from 'next/server';
import { z } from 'zod';
import { MarketId, MtfMode } from '@/lib/scanner/types';
import { listScanDates, loadScanSession } from '@/lib/storage/scanStorage';
import { apiOk, apiError, apiValidationError } from '@/lib/api/response';
import { passesMtf } from '@/lib/scanner/mtfPass';
import { getActiveStrategyServer } from '@/lib/strategy/activeStrategyServer';

export const runtime = 'nodejs';

const querySchema = z.object({
  market: z.enum(['TW', 'CN']).default('TW'),
  direction: z.enum(['long', 'short']).default('long'),
  mtf: z.enum(['daily', 'daily30', 'mtf', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J', 'K', 'L', 'M', 'N', 'O', 'P', 'Q', 'R', 'V', 'W', 'X', 'Y']).optional(),
  date: z.string().optional(),
  strategyId: z.string().optional(),
});

type StrategyTaggedSession = { strategyId?: string };

function sessionMatchesStrategy(session: StrategyTaggedSession, strategyId?: string): boolean {
  if (!strategyId) return true;
  if (session.strategyId) return session.strategyId === strategyId;
  // 舊 session 沒 metadata；歷史 daily 檔只允許純書本策略沿用。
  return strategyId === 'zhu-pure-book';
}

export async function GET(req: NextRequest) {
  const parsed = querySchema.safeParse(Object.fromEntries(new URL(req.url).searchParams));
  if (!parsed.success) return apiValidationError(parsed.error);
  const market: MarketId = parsed.data.market;
  const direction = parsed.data.direction;
  const mtfMode = parsed.data.mtf as MtfMode | undefined;
  const dateParam = parsed.data.date;

  // 2026-04-20 路由分流：
  //   - mtf=daily (default) → A 六條件 session
  //   - mtf=mtf → 讀 daily + 伺服器端過濾 mtfScore≥3
  //   - mtf=B/C/D/E → 讀買法獨立 session（filename mtfMode 位置存 B/C/D/E；2026-04-20 rename: 原 E→D, 原 F→E）
  const wantMtf = mtfMode === 'mtf';
  const isBuyMethod = mtfMode !== undefined && mtfMode !== 'daily' && mtfMode !== 'mtf';

  try {
    // 未指定時必須跟目前啟用策略一致；否則 UI 會在切換策略後默默讀回 legacy pool。
    const strategyId = parsed.data.strategyId ?? (await getActiveStrategyServer()).id;
    if (dateParam) {
      if (isBuyMethod) {
        const session = await loadScanSession(market, dateParam, direction, mtfMode as MtfMode, strategyId);
        return apiOk({ sessions: session ? [session] : [] });
      }
      const session = await loadScanSession(market, dateParam, direction, 'daily', strategyId);
      if (!session || !sessionMatchesStrategy(session as StrategyTaggedSession, strategyId)) {
        return apiOk({ sessions: [] });
      }
      if (wantMtf) {
        const filtered = session.results.filter(r => passesMtf(r));
        return apiOk({ sessions: [{ ...session, results: filtered, resultCount: filtered.length, multiTimeframeEnabled: true }] });
      }
      return apiOk({ sessions: [session] });
    }

    if (isBuyMethod) {
      const dates = await listScanDates(market, direction, mtfMode as MtfMode, strategyId);
      const sessions = dates.map(d => ({
        id: `${d.market}-${d.direction ?? 'long'}-${mtfMode}-${d.date}`,
        market: d.market,
        date: d.date,
        direction: d.direction,
        mtfMode,
        scanTime: d.scanTime,
        resultCount: d.resultCount,
      }));
      return apiOk({ sessions });
    }

    // Return all available dates — 統一讀 daily 清單，mtf 開時 resultCount 需重算
    const dates = await listScanDates(market, direction, 'daily', strategyId);
    const candidateSessions = await Promise.all(dates.map(async d => {
      const base = {
        id: `${d.market}-${d.direction ?? 'long'}-${wantMtf ? 'mtf' : 'daily'}-${d.date}`,
        market: d.market,
        date: d.date,
        direction: d.direction,
        mtfMode: wantMtf ? 'mtf' : 'daily',
        scanTime: d.scanTime,
        resultCount: d.resultCount,
      };
      const full = await loadScanSession(market, d.date, direction, 'daily', strategyId);
      if (!full || !sessionMatchesStrategy(full, strategyId)) return null;
      if (!wantMtf) return { ...base, resultCount: full.resultCount };
      const filtered = full.results.filter(r => passesMtf(r));
      return { ...base, resultCount: filtered.length };
    }));
    const sessions = candidateSessions.filter(session => session !== null);

    return apiOk({ sessions });
  } catch (err: unknown) {
    console.error('[scanner/results] error:', err);
    return apiError('掃描服務暫時無法使用');
  }
}
