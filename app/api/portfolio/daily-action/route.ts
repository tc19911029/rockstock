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
import { evaluateHolding, DEFAULT_STOP_LOSS_MULT, type HoldingActionResult } from '@/lib/agents/holdingsActionEngine';
import { readAveragedDownFlag } from '@/lib/portfolio/averagingDownGuard';
import { computeProfitTargets } from '@/lib/sell/profitTargets';
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
  /** 賠少-1：部位方向（'short' = 做空回補語意）；缺省 = 'long' 做多。 */
  positionSide?: 'long' | 'short';
  todayClose: number | null;
  asOfDate: string | null;
  unrealizedAmount: number | null;
  action: HoldingActionResult['action'] | 'no_data';
  label: string;
  signals: HoldingActionResult['signals'];
  profitPct: number | null;
  suggestedStop: number | null;
  metrics: HoldingActionResult['metrics'] | null;
  /** 課程 CH9-2（2026-07-04）：六壓力位中最近的上方壓力價（純顯示；null = 創新高無壓/資料不足） */
  nearestTarget?: number | null;
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
        const stopLoss = h.stopLoss ?? h.entryPrice * DEFAULT_STOP_LOSS_MULT;
        // 賠少-1：做空 live 風控 — positionSide / 進場黑K最高點皆走 ui blob passthrough。
        // 缺省（既有持倉）= 做多，行為位元不變。
        const positionSide: 'long' | 'short' = h.ui?.positionSide === 'short' ? 'short' : 'long';
        const base: Omit<DailyActionItem, 'todayClose' | 'asOfDate' | 'unrealizedAmount' | 'action' | 'label' | 'signals' | 'profitPct' | 'suggestedStop' | 'metrics'> = {
          symbol: h.symbol,
          name: h.name,
          market: h.market,
          entryDate: h.entryDate,
          entryPrice: h.entryPrice,
          stopLoss,
          shares: h.shares,
          positionSide,
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
        // 賠少-17：進場買法字母在 ui.triggerSignal（passthrough blob）→ 傳給 engine
        // 判斷是否為逆勢/搶反彈軌（反轉軌 D/F/N/O）以走專屬「翻黑就走」出場。
        const triggerSignal = typeof h.ui?.triggerSignal === 'string' ? h.ui.triggerSignal : undefined;
        // 賠少-1：做空進場黑K最高點（停損價）走 ui.entryKbar.high。
        const entryKbar = h.ui?.entryKbar as { high?: number; low?: number } | undefined;
        const entryHigh = typeof entryKbar?.high === 'number' ? entryKbar.high : undefined;
        // 賠少-10（2026-07-04）：做多生死線=進場K線低點。優先 ui.entryKbar.low，
        // 缺值 fallback 用 candles 裡 entryDate 那根的 low（找不到該日就不判）。
        const entryKlineLow = typeof entryKbar?.low === 'number'
          ? entryKbar.low
          : candles.find(c => c.date === h.entryDate)?.low;
        const result = evaluateHolding({
          symbol: h.symbol,
          entryPrice: h.entryPrice,
          stopLoss,
          candles,
          todayClose,
          thresholds,
          triggerSignal,
          positionSide,
          entryHigh,
          entryKlineLow,
        });
        // 課程 CH9-2（2026-07-04）：六壓力位最近上方壓力價（純顯示）
        const profitTargets = positionSide === 'long' ? computeProfitTargets(candles, 'short') : null;
        // 課程 CH10-2（2026-07-04）：向下攤平紅旗（upsert 咽喉寫入 ui.disciplineFlags）→ 常駐透出到平倉
        const avgDown = readAveragedDownFlag(h.ui);
        const signals = avgDown
          ? [{
              type: 'averaging_down_flag',
              label: '🚩 向下攤平（紀律紅旗）',
              severity: 'high' as const,
              detail: `${avgDown.date} 曾虧損中向下攤平（均價 ${avgDown.fromPrice} → ${avgDown.toPrice}）。課程 CH10-2：攤平=加碼下跌中的股票，完全錯誤；紅旗常駐到平倉`,
            }, ...result.signals]
          : result.signals;
        return {
          ...base,
          todayClose,
          asOfDate: lastCandle.date,
          // 賠少-1：做空未實現損益反向（放空後下跌才賺）；做多 / 缺省維持原算式。
          unrealizedAmount: positionSide === 'short'
            ? (h.entryPrice - todayClose) * h.shares
            : (todayClose - h.entryPrice) * h.shares,
          action: result.action,
          label: result.label,
          signals,
          profitPct: result.profitPct,
          suggestedStop: result.suggestedStop,
          metrics: result.metrics,
          nearestTarget: profitTargets?.nearestAbove ?? null,
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
