/**
 * blowoffDetector — 分鐘 K 線爆量警示規則
 *
 * ⚠ 警告：朱老師書本「爆量長黑=出貨」「末升段三條件」原文皆為日 K，
 * 本檔把規則套到分鐘 K 是分時類推、未經回測，所有 Signal 帶
 * caveat: 'minute-inference' 標記。UI / ntfy 三處露出 caveat banner。
 *
 * 4 種規則（純函數，無 IO）：
 *   1. blowoff-bearish   — 爆量長黑（見高/出貨訊號）
 *   2. blowoff-bullish   — 爆量長紅 + 突破前 N 根高點（起漲訊號）
 *   3. terminal-rally    — 末升段三條件：連 3 長紅 + 暴量 + MA20 乖離 > 15%
 *   4. ma5-breakdown     — 5m K 收盤跌破 5m MA5（持股 only，需 tfMin=5）
 *
 * 通用排除：
 *   - bars.length < MIN_BARS_FOR_DETECT (20) → skip（樣本不足）
 *   - 開盤第一根 bar（含集合競價巨量會永遠誤判） → skip
 */

import type { MinuteBar } from './minuteBarStore';
import { REALTIME_RULES } from '@/lib/config';

export type RuleId =
  | 'blowoff-bearish'
  | 'blowoff-bullish'
  | 'terminal-rally'
  | 'ma5-breakdown';

// Per-bar dedup：key = `${symbol}:${rule}:${tfMin}`，value = barTs(最後一次 fire 的 bar)
// 同一根 bar 永不重 fire；dispatcher 那層另有 disk-backed 防 HMR / cold start
const lastFiredBarTs: Map<string, number> = new Map();

function makeFiredKey(symbol: string, rule: RuleId, tfMin: 1 | 5): string {
  return `${symbol}:${rule}:${tfMin}`;
}

/** test-only：清空 per-bar 記憶 */
export function _resetDetectorMemoryForTest(): void {
  lastFiredBarTs.clear();
}

export interface DetectorContext {
  symbol: string;
  market: 'TW' | 'CN';
  /** 持股才會收 ma5-breakdown，其他規則對所有人 */
  isHolding: boolean;
  /** 監控池來源（holdingsGuard scope gate 用；缺省視為 'scan'） */
  source?: 'holding' | 'manual' | 'watchlist' | 'scan' | 'lockroster';
  /** 中文名（推播標題用）；缺省 fallback 代號 */
  name?: string;
}

export interface Signal {
  rule: RuleId;
  symbol: string;
  market: 'TW' | 'CN';
  /** 觸發時 bar 的時間 (epoch ms) */
  ts: number;
  /** 該 bar 的 timeframe (1m / 5m) */
  tfMin: 1 | 5;
  /** Bar 摘要，給推播 message 用 */
  meta: {
    open: number;
    high: number;
    low: number;
    close: number;
    volume: number;
    /** vol / MA20(vol) — 爆量規則用 */
    volumeMultiplier: number;
    /** close / open - 1，% */
    pctChange: number;
    /** body / (high - low) — 實體比 */
    bodyRatio: number;
    /** MA20(close) 乖離率，% — 末升段用 */
    ma20Deviation?: number;
  };
  caveat: 'minute-inference';
  isHolding: boolean;
  /** 監控池來源透傳（holdingsGuard scope gate 用） */
  source?: 'holding' | 'manual' | 'watchlist' | 'scan' | 'lockroster';
  /** 中文名（推播標題用）；缺省 fallback 代號 */
  name?: string;
}

export interface DetectOptions {
  /** false = 只算候選、不消耗 per-bar dedup；供外部精準行情二次驗證。 */
  dedupe?: boolean;
}

/**
 * 偵測 — 對最新一根 bar 跑 4 規則
 *
 * @param bars   升序 1m 或 5m bars（同 tfMin）
 * @param ctx    symbol/market/isHolding
 * @param tfMin  1 = 1m 跑 bearish/bullish/terminal；5 = 5m 同上+ma5-breakdown
 */
export function detect(
  bars: MinuteBar[],
  ctx: DetectorContext,
  tfMin: 1 | 5 = 1,
  options: DetectOptions = {},
): Signal[] {
  if (bars.length < REALTIME_RULES.MIN_BARS_FOR_DETECT) return [];
  const last = bars[bars.length - 1];
  if (isFirstBarOfSession(last)) return [];

  const ma20Vol = sma(bars.slice(-20).map(b => b.volume));
  const ma20Close = sma(bars.slice(-20).map(b => b.close));
  if (ma20Vol <= 0) return [];

  const volMult = last.volume / ma20Vol;
  const range = last.high - last.low;
  const body = Math.abs(last.close - last.open);
  const bodyRatio = range > 0 ? body / range : 0;
  const pctChange = last.open > 0 ? (last.close - last.open) / last.open : 0;
  const ma20Deviation = ma20Close > 0 ? (last.close - ma20Close) / ma20Close : 0;

  const baseMeta = {
    open: last.open, high: last.high, low: last.low, close: last.close,
    volume: last.volume,
    volumeMultiplier: round2(volMult),
    pctChange: round2(pctChange * 100),
    bodyRatio: round2(bodyRatio),
    ma20Deviation: round2(ma20Deviation * 100),
  };

  const isBlowoff = volMult >= REALTIME_RULES.VOLUME_MULTIPLIER
    && bodyRatio >= REALTIME_RULES.BODY_RATIO_MIN;

  // Per-bar dedup：對同一根 bar (last.ts) 的同一個 rule+tfMin，永不重 fire。
  // 規則：先把所有 candidate signal 算出來，再 filter 掉已 fire 過 last.ts 的；
  //       fire 完更新 lastFiredBarTs。
  const candidates: Array<{ rule: RuleId; sig: Signal }> = [];

  // Rule 1: blowoff-bearish — 爆量長黑
  // 書本原文：日 K「爆大量收長黑 → 出貨見高訊號」(分時推論)
  if (isBlowoff && last.close < last.open) {
    candidates.push({ rule: 'blowoff-bearish', sig: makeSignal('blowoff-bearish', ctx, last, tfMin, baseMeta) });
  }

  // Rule 2: blowoff-bullish — 爆量長紅 + 突破前 N 根 high
  // 書本原文：日 K「爆量收長紅 + 突破前高 → 起漲訊號」(分時推論)
  if (isBlowoff && last.close > last.open) {
    const lookback = REALTIME_RULES.BULLISH_BREAKOUT_LOOKBACK;
    const prevHigh = bars.slice(-1 - lookback, -1).reduce(
      (m, b) => Math.max(m, b.high), 0,
    );
    if (prevHigh > 0 && last.close > prevHigh) {
      candidates.push({ rule: 'blowoff-bullish', sig: makeSignal('blowoff-bullish', ctx, last, tfMin, baseMeta) });
    }
  }

  // Rule 3: terminal-rally — 末升段三條件
  // 書本原文：日 K「連 3 長紅 + 暴量 + MA20 乖離 > 15% → 末升段警示」(分時推論)
  const streak = REALTIME_RULES.TERMINAL_RALLY_STREAK;
  if (bars.length >= streak) {
    const tail = bars.slice(-streak);
    const allLongRed = tail.every(b => {
      const r = b.high - b.low;
      const body = Math.abs(b.close - b.open);
      return b.close > b.open && r > 0 && body / r >= REALTIME_RULES.BODY_RATIO_MIN;
    });
    const lastIsBlowoff = volMult >= REALTIME_RULES.VOLUME_MULTIPLIER;
    const deviationOver = ma20Deviation > REALTIME_RULES.TERMINAL_RALLY_DEVIATION;
    if (allLongRed && lastIsBlowoff && deviationOver) {
      candidates.push({ rule: 'terminal-rally', sig: makeSignal('terminal-rally', ctx, last, tfMin, baseMeta) });
    }
  }

  // Rule 4: ma5-breakdown — 持股 only、5m only
  // 書本原文：日 K「短線停利 = 收盤跌破 MA5」(分時推論)
  if (tfMin === 5 && ctx.isHolding) {
    const ma5 = sma(bars.slice(-5).map(b => b.close));
    if (ma5 > 0 && last.close < ma5) {
      candidates.push({ rule: 'ma5-breakdown', sig: makeSignal('ma5-breakdown', ctx, last, tfMin, baseMeta) });
    }
  }

  const candidateSignals = candidates.map(candidate => candidate.sig);
  return options.dedupe === false ? candidateSignals : dedupeSignals(candidateSignals);
}

/**
 * 對已經過外部行情驗證的訊號套用 detector 的 per-bar dedup。
 * 拆成公開 helper，避免快速預篩階段先把 key 吃掉，導致精準驗證後反而不能推播。
 */
export function dedupeSignals(signals: Signal[]): Signal[] {
  const out: Signal[] = [];
  for (const sig of signals) {
    const key = makeFiredKey(sig.symbol, sig.rule, sig.tfMin);
    if (lastFiredBarTs.get(key) === sig.ts) continue;
    lastFiredBarTs.set(key, sig.ts);
    out.push(sig);
  }
  return out;
}

// ── helpers ──────────────────────────────────────────────────────────────

function makeSignal(
  rule: RuleId,
  ctx: DetectorContext,
  bar: MinuteBar,
  tfMin: 1 | 5,
  meta: Signal['meta'],
): Signal {
  return {
    rule,
    symbol: ctx.symbol,
    market: ctx.market,
    ts: bar.ts,
    tfMin,
    meta,
    caveat: 'minute-inference',
    isHolding: ctx.isHolding,
    source: ctx.source,
    name: ctx.name,
  };
}

function sma(arr: number[]): number {
  if (arr.length === 0) return 0;
  let sum = 0;
  for (const v of arr) sum += v;
  return sum / arr.length;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * 判斷 bar 是否為當日開盤第一根（含集合競價 → 永遠最大量）
 * TW: 09:00 是第一根
 * CN: 09:30 是連續競價第一根（Sina 1m 也從 09:30 開始；09:15-09:25 集合競價不入 1m K）
 *
 * 注意：用 bar.ts 的市場時區小時/分鐘判斷，不依賴 ring buffer 的 index 順序
 * （buffer 可能滾過了，bars[0] 不一定是當日第一根）。
 */
function isFirstBarOfSession(bar: MinuteBar): boolean {
  const tz = bar.market === 'TW' ? 'Asia/Taipei' : 'Asia/Shanghai';
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(new Date(bar.ts)).split(':');
  const hhmm = parseInt(parts[0], 10) * 100 + parseInt(parts[1], 10);
  if (bar.market === 'TW') return hhmm === 900; // 09:00
  return hhmm === 930;                          // CN: 09:30
}
