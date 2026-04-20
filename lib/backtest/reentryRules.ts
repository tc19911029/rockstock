/**
 * 再進場分支判斷（書本對齊）
 *
 * 朱家泓書本對「初次進場」與「出場後再進場」差別處理：
 *   - 戰法 1 波浪戰法（p.238-244）：跌破 MA5 出場後，趨勢未破 + 再站上 MA5 = 再進場
 *   - 戰法 4 二條均線（p.276-285）：跌破 MA10 出場後，MA10 持續上揚 + 再站上 MA10 = 再進場
 *   - 戰法 9 續勢戰法（p.301-311）：第 1 段上漲後修正，4 種較簡單情況之一即可進場
 *
 * 對照初次進場（六條件 + 戒律 + 淘汰法 + MTF），條件大幅放寬。
 *
 * 此檔純函式，不修改全域狀態，方便在回測腳本與單元測試中共用。
 */

import type { CandleWithIndicators } from '@/types';
import type { ReentryConfig } from '@/lib/strategy/StrategyConfig';
import { findPivots, detectTrend } from '@/lib/analysis/trendAnalysis';

export interface ReentryWindow {
  /** 進場時記錄的 symbol，避免和其他股票串接 */
  symbol: string;
  /** 觸發再進場視窗的出場原因（白名單已過濾） */
  exitReason: 'ma5StopLoss' | 'ma10StopLoss';
  /** 視窗開啟當日的 candle index */
  openedAtIndex: number;
  /** 過期 index（含），超過則視窗失效 */
  expiresAtIndex: number;
}

export interface ReentrySignal {
  triggered: boolean;
  /** 各檢查項通過狀態，方便除錯與單元測試 */
  checks: {
    trendIntact: boolean;
    maReclaimed: boolean;
    volumeOk: boolean;
  };
  /** 失敗原因（人類可讀，多項以、分隔） */
  failReason?: string;
}

/**
 * 判斷指定出場原因是否屬於可開啟再進場視窗的白名單。
 */
export function shouldOpenReentryWindow(
  exitReason: string,
  config: ReentryConfig | undefined,
): exitReason is 'ma5StopLoss' | 'ma10StopLoss' {
  if (!config?.enabled) return false;
  return (config.triggerExitReasons as readonly string[]).includes(exitReason);
}

/**
 * 計算再進場視窗的過期 index。
 */
export function buildReentryWindow(
  symbol: string,
  exitReason: 'ma5StopLoss' | 'ma10StopLoss',
  exitIndex: number,
  config: ReentryConfig,
): ReentryWindow {
  return {
    symbol,
    exitReason,
    openedAtIndex: exitIndex,
    expiresAtIndex: exitIndex + Math.max(1, config.maxBarsAfterExit),
  };
}

/**
 * 在指定 K 棒判斷再進場是否觸發。
 *
 * 若回傳 triggered=true，呼叫端應在「下一根 K 棒開盤」買入（與初次進場一致），
 * 並把停損設在進場當日 K 棒最低點（書本標準）。
 *
 * 邏輯：
 *   1. requireTrendIntact：detectTrend(index) 仍為「多頭」（findPivots 沒出現頭頭低）
 *   2. requireMaReclaimed：close > MA5 且 MA5 > 5 根前的 MA5（上揚）
 *   3. requireVolumeOk：當日 volume ≥ 5 日均量 × 0.8（不要求放大，書本未要求）
 */
export function evaluateReentry(
  candles: CandleWithIndicators[],
  index: number,
  config: ReentryConfig,
): ReentrySignal {
  const checks = {
    trendIntact: !config.requireTrendIntact,
    maReclaimed: !config.requireMaReclaimed,
    volumeOk: !config.requireVolumeOk,
  };
  const failures: string[] = [];

  const candle = candles[index];
  if (!candle) {
    return { triggered: false, checks, failReason: '無 K 棒資料' };
  }

  if (config.requireTrendIntact) {
    const trend = detectTrend(candles, index);
    checks.trendIntact = trend === '多頭';
    if (!checks.trendIntact) failures.push(`趨勢=${trend}`);
  }

  if (config.requireMaReclaimed) {
    const ma5 = candle.ma5;
    const prevMa5 = candles[index - 5]?.ma5;
    const aboveMa5 = ma5 != null && candle.close > ma5;
    const ma5Rising = ma5 != null && prevMa5 != null && ma5 > prevMa5;
    checks.maReclaimed = !!(aboveMa5 && ma5Rising);
    if (!checks.maReclaimed) {
      if (!aboveMa5) failures.push('未站上 MA5');
      else if (!ma5Rising) failures.push('MA5 未上揚');
    }
  }

  if (config.requireVolumeOk) {
    const vols: number[] = [];
    for (let i = Math.max(0, index - 5); i < index; i++) {
      const v = candles[i]?.volume;
      if (typeof v === 'number') vols.push(v);
    }
    const avg = vols.length > 0 ? vols.reduce((a, b) => a + b, 0) / vols.length : 0;
    const todayVol = candle.volume ?? 0;
    checks.volumeOk = avg === 0 ? true : todayVol >= avg * 0.8;
    if (!checks.volumeOk) failures.push('量能崩塌');
  }

  const triggered = checks.trendIntact && checks.maReclaimed && checks.volumeOk;
  return {
    triggered,
    checks,
    failReason: triggered ? undefined : failures.join('、'),
  };
}

/**
 * 判斷再進場視窗是否仍有效（未過期）。
 */
export function isReentryWindowActive(
  window: ReentryWindow | null,
  currentIndex: number,
): boolean {
  if (!window) return false;
  return currentIndex > window.openedAtIndex && currentIndex <= window.expiresAtIndex;
}

/**
 * 判斷趨勢「自視窗開啟以來」是否仍多頭。
 *
 * 與單純 detectTrend 不同：本函式比對視窗開啟當下的 pivot 數量與最新 pivot 數量，
 * 若期間出現新頭頭低（最新頭比前一頭低），則視為趨勢已破，不再讓再進場觸發。
 */
export function isTrendIntactSinceWindow(
  candles: CandleWithIndicators[],
  window: ReentryWindow,
  currentIndex: number,
): boolean {
  const trend = detectTrend(candles, currentIndex);
  if (trend !== '多頭') return false;

  // 額外檢查：視窗開啟後是否出現新的頭頭低
  const pivots = findPivots(candles, currentIndex, 6);
  const highs = pivots.filter(p => p.type === 'high');
  if (highs.length >= 2) {
    const [latest, prev] = highs;
    if (latest.index >= window.openedAtIndex && latest.price < prev.price) {
      return false;
    }
  }
  return true;
}
