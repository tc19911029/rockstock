/**
 * GET /api/portfolio/daily-action
 *
 * 對 holdings.json 內所有 open 持倉跑書本訊號 audit：
 *   - 跌破停損 → stop_loss
 *   - 跌破 MA10 + 漲幅 ≥10% → exit_all（中線停利）
 *   - 跌破 MA20 + 漲幅 ≥20% → exit_all（長線停利）
 *   - 跌破 MA5 + 漲幅 ≥10% → reduce_half（短線停利）
 *   - 回測 MA5 不破 + 強多頭 → can_add
 *   - 其他 → hold
 *
 * 大盤 regime 來自 ^TWII；today price 來自 L2 注入後的 last candle close。
 */

import { NextRequest } from 'next/server';
import { apiError, apiOk } from '@/lib/api/response';
import { listOpenHoldings } from '@/lib/agents/portfolio/storage';
import { resolveProfileId } from '@/lib/portfolio/profiles';
import { loadLocalCandles } from '@/lib/datasource/LocalCandleStore';
import { injectL2TodayIfNeeded } from '@/lib/datasource/injectL2Today';
import { evaluateHolding, type HoldingActionResult } from '@/lib/agents/holdingsActionEngine';
import { detectMarketRegime, thresholdsForRegime, type RegimeDetectResult } from '@/lib/agents/marketRegime';
import { todayYmdTaipei } from '@/lib/youtube/classify';
import type { PortfolioHolding } from '@/lib/agents/portfolio/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export interface DailyActionItem {
  symbol: string;
  name: string;
  market: string;
  entryDate: string;
  entryPrice: number;
  stopLoss: number;
  shares: number;
  todayClose: number | null;
  asOfDate: string | null;
  unrealizedAmount: number | null;
  action: HoldingActionResult['action'] | 'no_data';
  label: string;
  signals: HoldingActionResult['signals'];
  profitPct: number | null;
  suggestedStop: number | null;
  metrics: HoldingActionResult['metrics'] | null;
}

export interface DailyActionResponse {
  generatedAt: string;
  date: string;
  marketRegime: RegimeDetectResult;
  totalUnrealized: number;
  items: DailyActionItem[];
}

export async function GET(req: NextRequest) {
  try {
    const today = todayYmdTaipei(new Date());
    const profileId = resolveProfileId(new URL(req.url).searchParams.get('profile'));
    const holdings = await listOpenHoldings(profileId);
    // 2026-06-14：擴成台股+陸股皆出停損檢查（賠少 P0③ CN 補齊）。evaluateHolding 市場無關。
    const activeHoldings = holdings.filter(h => h.market === 'TW' || h.market === 'CN');

    // 各市場大盤 regime（TW=^TWII / CN=上證000001.SS）— 快取，缺資料退中性多頭門檻
    const regimeCache: Record<string, { regime: RegimeDetectResult; thresholds: ReturnType<typeof thresholdsForRegime> }> = {};
    async function regimeFor(mkt: 'TW' | 'CN') {
      if (regimeCache[mkt]) return regimeCache[mkt];
      const idx = mkt === 'CN' ? '000001.SS' : '^TWII';
      let ic = await loadLocalCandles(idx, mkt);
      ic = await injectL2TodayIfNeeded(ic, idx, mkt, today);
      const regime = detectMarketRegime(ic);
      regimeCache[mkt] = { regime, thresholds: thresholdsForRegime(regime.regime) };
      return regimeCache[mkt];
    }
    // 回應的單一 marketRegime 維持 ^TWII（向下相容；各持倉內部用自己市場的 regime）
    const marketRegime = (await regimeFor('TW')).regime;

    const items: DailyActionItem[] = await Promise.all(
      activeHoldings.map(async (h: PortfolioHolding): Promise<DailyActionItem> => {
        const mkt = (h.market === 'CN' ? 'CN' : 'TW') as 'TW' | 'CN';
        const { thresholds } = await regimeFor(mkt);
        const stopLoss = h.stopLoss ?? h.entryPrice * 0.93;
        const base: Omit<DailyActionItem, 'todayClose' | 'asOfDate' | 'unrealizedAmount' | 'action' | 'label' | 'signals' | 'profitPct' | 'suggestedStop' | 'metrics'> = {
          symbol: h.symbol,
          name: h.name,
          market: h.market,
          entryDate: h.entryDate,
          entryPrice: h.entryPrice,
          stopLoss,
          shares: h.shares,
        };

        let candles = await loadLocalCandles(h.symbol, mkt);
        if ((!candles || candles.length === 0) && mkt === 'TW') {
          const otc = h.symbol.replace(/\.TW$/, '.TWO');
          candles = await loadLocalCandles(otc, 'TW');
        }
        candles = await injectL2TodayIfNeeded(candles, h.symbol, mkt, today);
        if (!candles || candles.length === 0) {
          return {
            ...base,
            todayClose: null, asOfDate: null, unrealizedAmount: null,
            action: 'no_data', label: '⚠ 無 K 線',
            signals: [], profitPct: null, suggestedStop: null, metrics: null,
          };
        }

        const lastCandle = candles[candles.length - 1];
        const todayClose = lastCandle.close;
        const result = evaluateHolding({
          symbol: h.symbol,
          entryPrice: h.entryPrice,
          stopLoss,
          candles,
          todayClose,
          thresholds,
        });
        return {
          ...base,
          todayClose,
          asOfDate: lastCandle.date,
          unrealizedAmount: (todayClose - h.entryPrice) * h.shares,
          action: result.action,
          label: result.label,
          signals: result.signals,
          profitPct: result.profitPct,
          suggestedStop: result.suggestedStop,
          metrics: result.metrics,
        };
      }),
    );

    const totalUnrealized = items.reduce((sum, it) => sum + (it.unrealizedAmount ?? 0), 0);

    return apiOk<DailyActionResponse>({
      generatedAt: new Date().toISOString(),
      date: today,
      marketRegime,
      totalUnrealized,
      items,
    });
  } catch (err) {
    return apiError(`daily-action failed: ${(err as Error).message}`, 500);
  }
}
