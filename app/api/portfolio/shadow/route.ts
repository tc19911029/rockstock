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
import { resolveHoldingReferencePrice } from '@/lib/portfolio/holdingReferencePrice';
import { resolveHoldingStrategyContext } from '@/lib/portfolio/holdingStrategyContext';
import { fallbackHoldingStop } from '@/lib/portfolio/holdingRisk';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export interface ShadowResponse {
  generatedAt: string;
  items: Array<ShadowResult & { name: string }>;
  totalDisciplineGap: number;
  unresolved: Array<{ symbol: string; name: string; missing: string[] }>;
}

export async function GET(req: NextRequest) {
  try {
    const today = todayYmdTaipei(new Date());
    const profileId = resolveProfileId(new URL(req.url).searchParams.get('profile'));
    const holdings = (await listOpenHoldings(profileId)).filter(h => h.market === 'TW');

    const items: Array<ShadowResult & { name: string }> = [];
    const unresolved: ShadowResponse['unresolved'] = [];
    for (const h of holdings) {
      const strategyContext = resolveHoldingStrategyContext(h.ui);
      if (h.ui?.positionSide !== 'short' && strategyContext.status === 'unknown') {
        unresolved.push({ symbol: h.symbol, name: h.name, missing: strategyContext.missing });
        continue;
      }
      let candles = await loadLocalCandles(h.symbol, 'TW');
      if (!candles || candles.length === 0) {
        candles = await loadLocalCandles(h.symbol.replace(/\.TW$/, '.TWO'), 'TW');
      }
      candles = await injectL2TodayIfNeeded(candles, h.symbol, 'TW', today);
      if (!candles || candles.length === 0) continue;
      const reference = resolveHoldingReferencePrice(h, candles);
      if (reference.price == null) continue;
      const positionSide: 'long' | 'short' = h.ui?.positionSide === 'short' ? 'short' : 'long';
      const entryKbar = h.ui?.entryKbar as { high?: number } | undefined;
      const r = computeShadowLedger({
        symbol: h.symbol,
        entryDate: h.entryDate,
        entryPrice: reference.price,
        shares: h.shares,
        stopLoss: h.stopLoss ?? fallbackHoldingStop(reference.price, positionSide),
        candles,
        positionSide,
        entryHigh: typeof entryKbar?.high === 'number' ? entryKbar.high : undefined,
        operationMode: strategyContext.operationMode,
        triggerSignal: strategyContext.triggerSignal,
        managementStrategy: strategyContext.managementStrategy,
        ui: h.ui,
        previousActiveStop: h.riskState?.activeStopLoss,
      });
      if (r) items.push({ ...r, name: h.name });
    }

    const totalDisciplineGap = items.reduce((s, x) => s + x.disciplineGap, 0);
    return apiOk<ShadowResponse>({ generatedAt: new Date().toISOString(), items, totalDisciplineGap, unresolved });
  } catch (err) {
    return apiError(err instanceof Error ? err.message : String(err));
  }
}
