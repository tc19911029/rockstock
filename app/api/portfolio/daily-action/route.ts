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
import { loadAllHoldings } from '@/lib/agents/portfolio/storage';
import { resolveProfileId } from '@/lib/portfolio/profiles';
import { loadLocalCandles } from '@/lib/datasource/LocalCandleStore';
import { injectL2TodayIfNeeded } from '@/lib/datasource/injectL2Today';
import { evaluateHolding, type HoldingActionResult } from '@/lib/agents/holdingsActionEngine';
import { readAveragedDownFlag } from '@/lib/portfolio/averagingDownGuard';
import { readStopLossLoweredFlag } from '@/lib/portfolio/stopLossGuard';
import { computeProfitTargets } from '@/lib/sell/profitTargets';
import { detectMarketRegime, thresholdsForRegime, type RegimeDetectResult } from '@/lib/agents/marketRegime';
import { todayYmdTaipei } from '@/lib/youtube/classify';
import type { PortfolioHolding } from '@/lib/agents/portfolio/types';
import type { OperationMode } from '@/lib/sell/v12Operation';
import { classifyPortfolioNotificationBasis } from '@/lib/portfolio/notifyPolicy';
import { resolveHoldingReferencePrice } from '@/lib/portfolio/holdingReferencePrice';
import { computeIndicators } from '@/lib/indicators';
import { deriveActiveLongStop, fallbackHoldingStop } from '@/lib/portfolio/holdingRisk';
import { evaluateElimination } from '@/lib/scanner/eliminationFilter';
import {
  BLOWOFF_PARTIAL_EXIT_SIGNAL_TYPE_SET,
  PARTIAL_EXIT_SIGNAL_TYPE_SET,
  partialExitForSignal,
} from '@/lib/portfolio/holdingExecution';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export interface DailyActionItem {
  symbol: string;
  name: string;
  market: string;
  entryDate: string;
  entryPrice: number;
  /** 技術規則使用的正參考價；帳務 entryPrice=0（配股）時與帳務成本分離。 */
  strategyReferencePrice?: number | null;
  stopLoss: number;
  shares: number;
  /** 賠少-1：部位方向（'short' = 做空回補語意）；缺省 = 'long' 做多。 */
  positionSide?: 'long' | 'short';
  /** 課程 CH8：此持倉實際採用的短線／長線操作模式。 */
  operationMode?: OperationMode;
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
  /**
   * 課程「收盤確認」鐵律（2026-07-05）：盤中呼叫時今日 bar 是 L2 半根 K，
   * 收盤級規則（均線/K線出場）只能當「盤中預警」，收盤才確認。true = 盤中暫定。
   */
  intradayProvisional?: boolean;
  /** price=盤中觸價可即時提醒；close=只在尾盤執行窗或收盤後正式提醒。 */
  notificationBasis?: 'price' | 'close';
  /** active stop 的來源；避免把策略計算值誤認為使用者原始輸入。 */
  stopLossSource?: 'configured' | 'strategy_dynamic' | 'legacy_fallback';
  stopLossMethod?: string;
  /** 今日減半訊號是否已由使用者確認執行。 */
  partialExitExecuted?: boolean;
}

export interface DailyActionResponse {
  generatedAt: string;
  date: string;
  marketRegime: RegimeDetectResult;
  totalUnrealized: number;
  items: DailyActionItem[];
}

/**
 * 盤中判定（CST）：TW 09:00-13:45 / CN 09:30-15:10 之間視為盤中（今日 bar 是半根 K）。
 * 粗判即可 — 只影響「盤中預警」文案，不影響訊號計算。
 */
function isIntradayNow(market: 'TW' | 'CN'): boolean {
  const nowCst = new Date(Date.now() + 8 * 3600_000); // UTC+8
  const day = nowCst.getUTCDay();
  if (day === 0 || day === 6) return false;
  const hm = nowCst.getUTCHours() * 100 + nowCst.getUTCMinutes();
  return market === 'TW' ? hm >= 900 && hm <= 1345 : hm >= 930 && hm <= 1510;
}

export async function GET(req: NextRequest) {
  try {
    const today = todayYmdTaipei(new Date());
    const profileId = resolveProfileId(new URL(req.url).searchParams.get('profile'));
    const holdings = (await loadAllHoldings(profileId)).filter(h => h.status === 'open');
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
        const hasAccountingEntryPrice = Number.isFinite(h.entryPrice) && h.entryPrice > 0;
        const configuredStopLoss = h.stopLoss;
        // 賠少-1：做空 live 風控 — positionSide / 進場黑K最高點皆走 ui blob passthrough。
        // 缺省（既有持倉）= 做多，行為位元不變。
        const positionSide: 'long' | 'short' = h.ui?.positionSide === 'short' ? 'short' : 'long';
        // UI 建倉預設就是 short；舊資料缺欄位時沿用同一預設，避免 daily-action 落回另一套 legacy 均線。
        const operationMode: OperationMode = h.ui?.operationMode === 'long' ? 'long' : 'short';
        const base: Omit<DailyActionItem, 'todayClose' | 'asOfDate' | 'unrealizedAmount' | 'action' | 'label' | 'signals' | 'profitPct' | 'suggestedStop' | 'metrics'> = {
          symbol: h.symbol,
          name: h.name,
          market: h.market,
          entryDate: h.entryDate,
          entryPrice: h.entryPrice,
          stopLoss: configuredStopLoss ?? (hasAccountingEntryPrice ? fallbackHoldingStop(h.entryPrice, positionSide) : 0),
          shares: h.shares,
          positionSide,
          operationMode,
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
        const reference = resolveHoldingReferencePrice(h, candles);
        if (reference.price == null) {
          return {
            ...base,
            todayClose,
            asOfDate: lastCandle.date,
            unrealizedAmount: null,
            action: 'no_data',
            label: '⚠ 缺策略參考價',
            signals: [{
              type: 'invalid_entry_price',
              label: '策略參考價不可用',
              severity: 'high',
              detail: '帳務成本不是正數，且找不到明訂策略參考價或取得日附近 K 線；暫不計算停損與操作建議。',
            }],
            profitPct: null,
            suggestedStop: null,
            metrics: null,
            intradayProvisional: false,
          };
        }
        const strategyReferencePrice = reference.price;
        const withIndicators = computeIndicators(candles);
        // 賠少-17：進場買法字母在 ui.triggerSignal（passthrough blob）→ 傳給 engine
        // 判斷是否為逆勢/搶反彈軌（反轉軌 D/F/N/O）以走專屬「翻黑就走」出場。
        const triggerSignal = typeof h.ui?.triggerSignal === 'string' ? h.ui.triggerSignal : undefined;
        const activeStop = positionSide === 'long'
          ? deriveActiveLongStop({
              entryPrice: strategyReferencePrice,
              configuredStopLoss,
              entryDate: h.entryDate,
              triggerSignal,
              market: mkt,
              candles: withIndicators,
              ui: h.ui,
            })
          : {
              price: configuredStopLoss ?? fallbackHoldingStop(strategyReferencePrice, 'short'),
              method: configuredStopLoss ? '使用者已設定回補停損' : '舊持倉 7% 回補 fallback',
              source: configuredStopLoss ? 'configured' as const : 'legacy_fallback' as const,
            };
        const stopLoss = activeStop.price;
        // 賠少-1：做空進場黑K最高點（停損價）走 ui.entryKbar.high。
        const entryKbar = h.ui?.entryKbar as { high?: number; low?: number } | undefined;
        const entryHigh = typeof entryKbar?.high === 'number' ? entryKbar.high : undefined;
        // 賠少-10（2026-07-04）：做多生死線=進場K線低點。優先 ui.entryKbar.low，
        // 缺值 fallback 用 candles 裡 entryDate 那根的 low（找不到該日就不判）。
        const entryKlineLow = typeof entryKbar?.low === 'number'
          ? entryKbar.low
          : candles.find(c => c.date === h.entryDate)?.low;
        const yesterdayDate = candles.length >= 2 ? candles[candles.length - 2].date : '';
        const priorPartialExecution = partialExitForSignal(
          h.executionState,
          yesterdayDate,
          BLOWOFF_PARTIAL_EXIT_SIGNAL_TYPE_SET,
        );
        let result = evaluateHolding({
          symbol: h.symbol,
          entryPrice: strategyReferencePrice,
          stopLoss,
          candles,
          todayClose,
          thresholds,
          triggerSignal,
          operationMode,
          entryDate: h.entryDate,
          positionSide,
          entryHigh,
          entryKlineLow,
          priorPartialExit: priorPartialExecution
            ? { signalDate: priorPartialExecution.signalDate, sharesRemaining: priorPartialExecution.sharesRemaining }
            : undefined,
        });
        const partialSignal = result.signals.find(signal => PARTIAL_EXIT_SIGNAL_TYPE_SET.has(signal.type));
        const partialExecution = partialSignal
          ? partialExitForSignal(h.executionState, lastCandle.date, new Set([partialSignal.type]))
          : null;
        if (result.action === 'reduce_half' && partialExecution) {
          result = {
            ...result,
            action: 'hold',
            label: '✅ 今日減半已執行',
            signals: [{
              type: 'partial_exit_confirmed',
              label: `已賣 ${partialExecution.sharesSold}，剩 ${partialExecution.sharesRemaining}`,
              severity: 'low',
              detail: `${partialExecution.executedAt} 已確認執行 ${partialExecution.signalType}，不再重複提示賣半。`,
            }, ...result.signals],
          };
        }
        // 課程 CH9-2（2026-07-04）：六壓力位最近上方壓力價（純顯示）
        const profitTargets = positionSide === 'long' ? computeProfitTargets(candles, 'short') : null;
        // 課程 CH10-2（2026-07-04）：向下攤平紅旗（upsert 咽喉寫入 ui.disciplineFlags）→ 常駐透出到平倉
        const avgDown = readAveragedDownFlag(h.ui);
        // 課程 CH7-1（2026-07-06）：停損下修紅旗（upsert 咽喉寫入 ui.disciplineFlags）→ 常駐透出到平倉
        const slLowered = readStopLossLoweredFlag(h.ui);
        const disciplineSignals = [
          ...(slLowered ? [{
            type: 'stop_loss_lowered_flag',
            label: '🚩 停損往鬆改（紀律紅旗）',
            severity: 'high' as const,
            detail: `${slLowered.date} 曾把停損${slLowered.side === 'long' ? '往下' : '往上'}改（${slLowered.fromStop} → ${slLowered.toStop}）。課程 CH7-1：停損設了就不可以改，往鬆改＝等於沒設停損；紅旗常駐到平倉`,
          }] : []),
          ...(avgDown ? [{
            type: 'averaging_down_flag',
            label: '🚩 向下攤平（紀律紅旗）',
            severity: 'high' as const,
            detail: `${avgDown.date} 曾虧損中向下攤平（均價 ${avgDown.fromPrice} → ${avgDown.toPrice}）。課程 CH10-2：攤平=加碼下跌中的股票，完全錯誤；紅旗常駐到平倉`,
          }] : []),
        ];
        // 課程 CH11-2（2026-07-20 第七輪，逐字稿）：「連續上漲超過 3 天、漲幅超過 10% → 採取 K 線戰法停利」，
        // 且明講「第三天第四天黑K跌破昨天的低點我就賣了，**不一定有跌破五均**」。
        //
        // ⚠️ 回測結論（backtest-r7b-ch11-2-exit，n=10,962，train/test 分界 2025-04-14）：
        //   賠少側**大勝且兩段一致**：平均虧損 −4.3% vs 現行 −7.8%，P5 尾巴 −9.4% vs −14.5%，
        //   最差一筆 test −18.9% vs −90.3%。
        //   但期望值 test 段輸 1.38pp（多頭急著跑就少賺），且該狀態本身平均還會續漲
        //   （無腦抱 20 天 3.99% > 現行 1.89% > 課程 1.17%）。
        // → **裁決：不取代現行 20% 規則，只做 advisory**（同 ch83_touched_10pct 前例）。
        //   誰的優先序是「賠少」就照這個走；要賺滿的就忽略提示。
        const ch11ClimbExitAdvisory = (() => {
          if (positionSide !== 'long') return null;
          const n = candles.length;
          if (n < 5) return null;
          const today = candles[n - 1];
          const prevBar = candles[n - 2];
          // 連續上漲 3 天以上（收盤比昨收高，非看K棒顏色 — 課程 CH2-1 口徑）
          let upDays = 0;
          for (let i = n - 2; i >= 1; i--) {
            if (candles[i].close > candles[i - 1].close) upDays++;
            else break;
          }
          if (upDays < 3) return null;
          // 漲幅超過 10%（自這段連漲起點起算）
          const legStart = candles[n - 2 - upDays + 1 - 1] ?? candles[0];
          const legGainPct = legStart.close > 0 ? (prevBar.close - legStart.close) / legStart.close : 0;
          if (legGainPct < 0.10) return null;
          // 今日黑K收盤跌破昨天的最低點
          if (!(today.close < today.open && today.close < prevBar.low)) return null;
          return {
            type: 'ch11_climb3_break_prev_low',
            label: '📗 課程風控提示：連漲逾 3 天 +10% 後破昨低',
            severity: 'medium' as const,
            detail: `連續上漲 ${upDays} 天、這段漲幅 +${(legGainPct * 100).toFixed(1)}%，今日黑K收盤 ${today.close.toFixed(2)} 跌破昨日最低 ${prevBar.low.toFixed(2)}。課程 CH11-2：這時用 K 線戰法停利，不必等跌破 5 均。回測：照這條走平均虧損砍半（−4.3% vs −7.8%），但多頭段會少賺 — 系統硬出場未改，這是給「優先賠少」的紀律提示。`,
          };
        })();
        // 課程 CH2-4（2026-07-06，逐字-6）：大量長紅K 的最高價＝第一層支撐。跌破後「3~5 日內要站回紅K之上」，
        // 否則很有機會轉折向下。candleSRLevels 原本只畫線、無「已跌破 N 日未站回」監控 → 這裡補持倉/走圖提示（做多）。
        const srNoRegainAdvisory = (() => {
          if (positionSide !== 'long') return null;
          const n = candles.length;
          // 近 30 根找最後一根「大量長紅K」當支撐錨（實體≥2%、量≥5日均量×1.5）
          let anchorIdx = -1;
          for (let i = n - 2; i >= Math.max(1, n - 30); i--) {
            const k = candles[i];
            const body = k.open > 0 ? (k.close - k.open) / k.open : 0;
            if (!(k.close > k.open && body >= 0.02)) continue;
            const vols = candles.slice(Math.max(0, i - 5), i).map(x => x.volume);
            const avg5 = vols.length ? vols.reduce((a, b) => a + b, 0) / vols.length : 0;
            if (avg5 > 0 && k.volume >= avg5 * 1.5) { anchorIdx = i; break; }
          }
          if (anchorIdx < 0) return null;
          const anchorHigh = candles[anchorIdx].high;
          // 錨之後第一根收盤跌破 anchorHigh 的日子
          let breakIdx = -1;
          for (let i = anchorIdx + 1; i < n; i++) {
            if (candles[i].close < anchorHigh) { breakIdx = i; break; }
          }
          if (breakIdx < 0) return null;
          if (todayClose >= anchorHigh) return null; // 今日已站回，不警示
          const daysSince = (n - 1) - breakIdx + 1;
          if (daysSince < 3) return null; // 課程給 3~5 日緩衝
          return {
            type: 'ch24_support_no_regain',
            label: daysSince >= 5 ? '⚠️ 大量長紅高價跌破逾5日未站回' : '📗 大量長紅高價跌破，注意 3~5 日站回',
            severity: daysSince >= 5 ? 'high' as const : 'medium' as const,
            detail: `大量長紅K 最高價 ${anchorHigh.toFixed(2)}（第一層支撐）已跌破 ${daysSince} 日未站回（今收 ${todayClose.toFixed(2)}）。課程 CH2-4：跌破後 3~5 日內要站回紅K之上，否則很有機會轉折向下，宜提高警覺。`,
          };
        })();
        // 課程 CH7-3（2026-07-07，逐字-26）：每日檢視「自買價跌幅 > 5%」列警示股準備賣出（做多）。
        // 與賠少-16「當日跌幅>5%」（單日）、watch_stop（距停損<3%）基準不同 —— 這是自進場價的累計跌幅。
        const fromEntryAdvisory = (() => {
          if (positionSide !== 'long') return null;
          const dropFromEntry = (strategyReferencePrice - todayClose) / strategyReferencePrice;
          if (dropFromEntry <= 0.05) return null;
          return {
            type: 'ch73_down_5pct_from_entry',
            label: '📗 自買價已跌逾5%（警示股）',
            severity: 'medium' as const,
            detail: `自策略參考價 ${strategyReferencePrice} 跌 ${(dropFromEntry * 100).toFixed(1)}%（今收 ${todayClose.toFixed(2)}）。課程 CH7-3：每日檢視自買價跌幅 > 5% 應列警示股、準備賣出，別放任凹單。`,
          };
        })();
        const elimination = positionSide === 'long'
          ? evaluateElimination(withIndicators, withIndicators.length - 1)
          : { eliminated: false, reasons: [], penalty: 0 };
        const eliminationSignals = elimination.reasons.map((reason, index) => ({
          type: `position_elimination_${index + 1}`,
          label: `持股淘汰警示：${reason.replace(/^淘汰\d+:\s*/, '')}`,
          severity: 'high' as const,
          detail: `${reason}。這是 position_exit_warning，與選股 selection_reject 分開記錄；請依實際操作模式確認是否退出。`,
        }));
        const signals = [...eliminationSignals, ...disciplineSignals, ...(ch11ClimbExitAdvisory ? [ch11ClimbExitAdvisory] : []), ...(srNoRegainAdvisory ? [srNoRegainAdvisory] : []), ...(fromEntryAdvisory ? [fromEntryAdvisory] : []), ...result.signals];
        return {
          ...base,
          stopLoss,
          strategyReferencePrice,
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
          // 盤中且今日 bar 已被 L2 半根覆蓋 → 收盤級動作標「盤中預警」
          intradayProvisional: lastCandle.date === today && isIntradayNow(mkt),
          notificationBasis: classifyPortfolioNotificationBasis(signals),
          stopLossSource: activeStop.source,
          stopLossMethod: activeStop.method,
          partialExitExecuted: partialExecution != null,
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
