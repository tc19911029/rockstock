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
    const twHoldings = holdings.filter(h => h.market === 'TW');

    // 大盤 regime
    let indexCandles = await loadLocalCandles('^TWII', 'TW');
    indexCandles = await injectL2TodayIfNeeded(indexCandles, '^TWII', 'TW', today);
    const marketRegime = detectMarketRegime(indexCandles);
    const thresholds = thresholdsForRegime(marketRegime.regime);

    const items: DailyActionItem[] = await Promise.all(
      twHoldings.map(async (h: PortfolioHolding): Promise<DailyActionItem> => {
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

        let candles = await loadLocalCandles(h.symbol, 'TW');
        if (!candles || candles.length === 0) {
          const otc = h.symbol.replace(/\.TW$/, '.TWO');
          candles = await loadLocalCandles(otc, 'TW');
        }
        candles = await injectL2TodayIfNeeded(candles, h.symbol, 'TW', today);
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
