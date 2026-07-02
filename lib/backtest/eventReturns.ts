/**
 * 事件前瞻報酬 — pure，無 I/O。報酬不持久化，讀取時從 L1 K 線即時算。
 * 回測共用單一事實（YouTube 老師績效 + 陸股情緒回測共用）。
 *
 * 2026-06-13 從 lib/youtube/recoPerformance.ts 原樣搬移（搬移不重構）：
 * lib/youtube/recoPerformance.ts 為 thin re-export。指數是參數注入 —
 * 傳 ^TWII 算台股超額、傳 000001.SS 算陸股超額，邏輯零改動。
 *
 * 慣例（對齊 unifiedLeaderboard next_open 模式）：
 *   - i0 = base_date 那根（進場日）
 *   - dN = (close[i0 + N − 1] − entry_open) / entry_open × 100（d1 = 進場日自身收盤）
 *   - MFE/MAE 用 i0..i0+59 的 high/low vs entry_open
 *   - 超額 = 個股 dN − 指數同期 dN，指數按「日曆日」對齊（個股停牌缺根不會錯位）
 */

import type { BaselineCandle, RecoBaseline } from './eventBaseline';

// 2026-06-13 加 d2/d4（陸股要「推薦後第 1,2,3,4,5,10,20 日」連續口徑）。additive：
// YouTube 端用迴圈遍歷 RECO_HORIZONS，多兩個 horizon 不影響（UI 自選要顯示哪幾個）。
export type RecoHorizon = 'd1' | 'd2' | 'd3' | 'd4' | 'd5' | 'd10' | 'd20' | 'd60';

export const RECO_HORIZONS: RecoHorizon[] = ['d1', 'd2', 'd3', 'd4', 'd5', 'd10', 'd20', 'd60'];

/** 各 horizon 對「進場日那根」的 offset：dN = close[i0 + N − 1]（d1 = 進場日自身收盤） */
export const RECO_HORIZON_OFFSET: Record<RecoHorizon, number> = {
  d1: 0, d2: 1, d3: 2, d4: 3, d5: 4, d10: 9, d20: 19, d60: 59,
};

/** MFE/MAE 視窗：進場日起 60 根 */
export const RECO_MFE_BARS = 60;

export interface RecoReturns {
  /** 各 horizon 報酬 %（close vs entry_open）；K 線不足 → null */
  d1: number | null;
  d2: number | null;
  d3: number | null;
  d4: number | null;
  d5: number | null;
  d10: number | null;
  d20: number | null;
  d60: number | null;
  /** 60 根內最大有利波動（high vs entry_open）% */
  mfe: number | null;
  /** 60 根內最大不利波動（low vs entry_open）% */
  mae: number | null;
  /** 各 horizon 對指數的超額 %（按日曆日對齊）；缺指數資料 → null */
  excess: Record<RecoHorizon, number | null>;
  /** d60 尚未走完 → true（事件還開放中） */
  isOpen: boolean;
  /** 已追蹤到的最後一個交易日（受 visibleUntil 限制） */
  lastTrackedDate: string | null;
  /** 持有至今報酬 %：entry_open → 最後可見收盤（跟單「抱到現在」用）；無資料 → null */
  holdReturn: number | null;
  /** holdReturn 對指數同期的超額 % */
  holdExcess: number | null;
}

const round2 = (x: number): number => +x.toFixed(2);

/** 指數同期報酬：從 entryDate（含）到 targetDate（含）的 close-to-close %。日曆日對齊（找 ≤ date 的最近根）。 */
export function indexReturnBetween(
  indexCandles: BaselineCandle[],
  entryDate: string,
  targetDate: string,
): number | null {
  let entryIdx = -1;
  let targetIdx = -1;
  for (let i = indexCandles.length - 1; i >= 0; i--) {
    const d = indexCandles[i].date;
    if (targetIdx < 0 && d <= targetDate) targetIdx = i;
    if (d <= entryDate) { entryIdx = i; break; }
  }
  if (entryIdx < 0 || targetIdx < 0 || targetIdx < entryIdx) return null;
  // 基準用進場日「開盤」對齊個股 entry_open 的語義
  const base = indexCandles[entryIdx].open;
  if (!(base > 0)) return null;
  return (indexCandles[targetIdx].close - base) / base * 100;
}

/**
 * 算單一事件的報酬。baseline 非 filled → null。
 * @param stockCandles 該股全段 L1 K 線（升序）
 * @param indexCandles 指數全段（升序，台股 ^TWII / 陸股 000001.SS）；null = 不算超額
 * @param opts.visibleUntil as-of 時光機：只把 date ≤ visibleUntil 的 K 棒視為「已知」，
 *        之後的橫斷一律 null（模擬「站在那天，這檔的 dN 還沒走完」）。
 *        ⚠ 防前視偏誤的關鍵參數 — 算「截至 T 誰最準」時必傳 T，否則就是開上帝視角。
 *        預設 undefined → 看全部歷史（行為與重構前 byte-identical）。
 */
export function computeEventReturns(
  // 2026-06-13 收窄：原為 youtube domain 的 RecoEvent，實際只用 baseline 欄 —
  // 結構性放寬讓陸股事件（CnRecoEvent）免 import youtube 型別，youtube 呼叫方零變更
  event: { baseline: RecoBaseline },
  stockCandles: BaselineCandle[] | null,
  indexCandles: BaselineCandle[] | null,
  opts?: { visibleUntil?: string },
): RecoReturns | null {
  const { baseline } = event;
  if (baseline.status !== 'filled' || baseline.entry_open == null || !baseline.base_date) return null;
  if (!stockCandles || stockCandles.length === 0) return null;

  const i0 = stockCandles.findIndex(c => c.date === baseline.base_date);
  if (i0 < 0) return null;
  const base = baseline.entry_open;
  const visibleUntil = opts?.visibleUntil;
  const visible = (c: BaselineCandle): boolean => !visibleUntil || c.date <= visibleUntil;

  const horizonRet: Record<RecoHorizon, number | null> = {
    d1: null, d2: null, d3: null, d4: null, d5: null, d10: null, d20: null, d60: null,
  };
  const excess: Record<RecoHorizon, number | null> = {
    d1: null, d2: null, d3: null, d4: null, d5: null, d10: null, d20: null, d60: null,
  };

  for (const h of RECO_HORIZONS) {
    const idx = i0 + RECO_HORIZON_OFFSET[h];
    const c = stockCandles[idx];
    if (!c) continue;
    if (!visible(c)) continue;                 // as-of：那天該橫斷還沒走完
    const ret = round2((c.close - base) / base * 100);
    horizonRet[h] = ret;
    if (indexCandles) {
      const idxRet = indexReturnBetween(indexCandles, baseline.base_date, c.date);
      if (idxRet != null) excess[h] = round2(ret - idxRet);
    }
  }

  // MFE/MAE + 持有至今：進場日起 60 根，受 visibleUntil 限制
  let mfe: number | null = null;
  let mae: number | null = null;
  let lastTrackedDate: string | null = null;
  let lastClose: number | null = null;
  for (let k = 0; k < RECO_MFE_BARS; k++) {
    const c = stockCandles[i0 + k];
    if (!c) break;
    if (!visible(c)) break;                     // as-of：只看到 visibleUntil 為止
    lastTrackedDate = c.date;
    lastClose = c.close;
    const hi = (c.high - base) / base * 100;
    const lo = (c.low - base) / base * 100;
    if (mfe === null || hi > mfe) mfe = hi;
    if (mae === null || lo < mae) mae = lo;
  }
  if (mfe !== null) mfe = round2(mfe);
  if (mae !== null) mae = round2(mae);

  // 持有至今報酬（entry_open → 最後可見收盤）+ 同期指數超額
  let holdReturn: number | null = null;
  let holdExcess: number | null = null;
  if (lastClose != null) {
    holdReturn = round2((lastClose - base) / base * 100);
    if (indexCandles && lastTrackedDate) {
      const idxRet = indexReturnBetween(indexCandles, baseline.base_date, lastTrackedDate);
      if (idxRet != null) holdExcess = round2(holdReturn - idxRet);
    }
  }

  return {
    ...horizonRet,
    mfe,
    mae,
    excess,
    isOpen: horizonRet.d60 == null,
    lastTrackedDate,
    holdReturn,
    holdExcess,
  } as RecoReturns;
}

export interface TargetStopEval {
  target: number | null;
  stop: number | null;
  /** 盤中 high ≥ 目標價 的第一天（達標） */
  hitTarget: { date: string } | null;
  /** 盤中 low ≤ 停損價 的第一天（破停損） */
  hitStop: { date: string } | null;
  /** 先碰到哪個（同一根兩者都碰 → 保守算停損先） */
  first: 'target' | 'stop' | null;
}

/**
 * 判斷老師喊的目標價有沒有到、停損有沒有破（掃進場後 K 線盤中高低點）。
 * target/stop 皆無 → null（事件沒給價位）。visibleUntil 同 computeEventReturns（時光機防前視）。
 */
export function evalTargetStop(
  baseline: RecoBaseline,
  stockCandles: BaselineCandle[] | null,
  target: number | null | undefined,
  stop: number | null | undefined,
  opts?: { visibleUntil?: string },
): TargetStopEval | null {
  if (target == null && stop == null) return null;
  const out: TargetStopEval = { target: target ?? null, stop: stop ?? null, hitTarget: null, hitStop: null, first: null };
  if (baseline.status !== 'filled' || !baseline.base_date || !stockCandles) return out;
  const i0 = stockCandles.findIndex(c => c.date === baseline.base_date);
  if (i0 < 0) return out;
  const visibleUntil = opts?.visibleUntil;
  for (let k = i0; k < stockCandles.length; k++) {
    const c = stockCandles[k];
    if (visibleUntil && c.date > visibleUntil) break;
    // 同根兩者都碰 → 先記停損（保守假設先觸發停損）
    if (stop != null && out.hitStop == null && c.low <= stop) {
      out.hitStop = { date: c.date };
      if (!out.first) out.first = 'stop';
    }
    if (target != null && out.hitTarget == null && c.high >= target) {
      out.hitTarget = { date: c.date };
      if (!out.first) out.first = 'target';
    }
    if (out.hitTarget && out.hitStop) break;
  }
  return out;
}
