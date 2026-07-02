/**
 * GET /api/portfolio/shadow?profile=me
 *
 * 紀律影子帳本（2026-06-12，A2）：對所有 open TW 持倉重放書本出場規則，
 * 回每檔影子事件 + 紀律差額與總額。詳見 lib/portfolio/shadowLedger.ts。
 */
import { NextRequest } from 'next/server';
import { apiError, apiOk } from '@/lib/api/response';
import { listOpenHoldings } from '@/lib/agents/portfolio/storage';
import { resolveProfileId } from '@/lib/portfolio/profiles';
import { loadLocalCandles } from '@/lib/datasource/LocalCandleStore';
import { injectL2TodayIfNeeded } from '@/lib/datasource/injectL2Today';
import { computeShadowLedger, type ShadowResult } from '@/lib/portfolio/shadowLedger';
import { todayYmdTaipei } from '@/lib/youtube/classify';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export interface ShadowResponse {
  generatedAt: string;
  items: Array<ShadowResult & { name: string }>;
  totalDisciplineGap: number;
}

export async function GET(req: NextRequest) {
  try {
    const today = todayYmdTaipei(new Date());
    const profileId = resolveProfileId(new URL(req.url).searchParams.get('profile'));
    const holdings = (await listOpenHoldings(profileId)).filter(h => h.market === 'TW');

    const items: Array<ShadowResult & { name: string }> = [];
    for (const h of holdings) {
      let candles = await loadLocalCandles(h.symbol, 'TW');
      if (!candles || candles.length === 0) {
        candles = await loadLocalCandles(h.symbol.replace(/\.TW$/, '.TWO'), 'TW');
      }
      candles = await injectL2TodayIfNeeded(candles, h.symbol, 'TW', today);
      if (!candles || candles.length === 0) continue;
      const r = computeShadowLedger({
        symbol: h.symbol,
        entryDate: h.entryDate,
        entryPrice: h.entryPrice,
        shares: h.shares,
        stopLoss: h.stopLoss ?? h.entryPrice * 0.93,
        candles,
      });
      if (r) items.push({ ...r, name: h.name });
    }

    const totalDisciplineGap = items.reduce((s, x) => s + x.disciplineGap, 0);
    return apiOk<ShadowResponse>({ generatedAt: new Date().toISOString(), items, totalDisciplineGap });
  } catch (err) {
    return apiError(err instanceof Error ? err.message : String(err));
  }
}
