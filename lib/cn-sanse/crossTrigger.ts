// ============================================================
// 捕撈季節 金叉/死叉「觸發價」— 回答「今天收盤到多少錢會金叉/死叉？」
//
// 原理：XYS 快線(xys1)與慢線(xys2)都只被「今天這根」的 close/high/low 影響
//   （X1=(2C+H+L)/3 → 三重EMA → 日變化率；歷史各根已凍結）。
//   收盤價越高 → 快線越高；慢線只吃到 1/slowMa 的份 → 快慢線差對收盤價「嚴格單調遞增」。
//   → 二分搜出快線=慢線的臨界收盤價，就是今天的金叉/死叉觸發價。
//
// 只做顯示層（訊號面板的價位預告），不進選股/掃描/回測 — 不動 ConditionReport
//   （golden snapshot 釘死），route 另掛 catchTrigger 欄位。
// ============================================================

import { computeXys } from './dualB';
import { isNum } from './tdx';
import { PRODUCTION_PARAMS, type SanSeParams } from './params';
import type { Candle } from '@/types';

export interface CatchCrossTrigger {
  /** 昨日快線在慢線下方 → 今天只可能發生金叉；在上方 → 只可能死叉 */
  side: 'gold' | 'dead';
  /** 臨界收盤價：金叉=收盤 ≥ 此價觸發；死叉=收盤 ≤ 此價觸發。null=漲/跌停也到不了 */
  price: number | null;
  /** 觸發當下快線位置：>0 多頭區 / <0 空頭區（金叉分「趨勢延續 vs 底部反彈」用） */
  zone: 'bull' | 'bear' | null;
  /** 觸發價相對現價的 %（正=要再漲、負=要再跌）；price=null 時為 null */
  pctFromClose: number | null;
  /** 觸發價在今天漲跌停範圍內（false=今天不可能，最快也要明天） */
  reachable: boolean;
  /** 以現價算「今天已站在觸發側」＝收盤守住就成立（盤中可能來回） */
  crossedNow: boolean;
  /** 今天不管收在漲停還是跌停都會觸發（臨界價在漲跌停範圍外的另一側） */
  always: boolean;
}

const r2 = (x: number) => Math.round(x * 100) / 100;

/**
 * 算「今天」這根的捕撈金叉/死叉觸發價。
 * candles 最後一根＝今天（盤中半根或已收盤都可）；limitPct 依市場/板塊傳入（主板/台股 0.10、創業科創 0.20）。
 * 回 null＝資料不足（EMA 未熱身）或昨日快慢線重合（無明確方向）。
 */
export function computeCatchCrossTrigger(
  candles: Candle[],
  limitPct = 0.10,
  p: SanSeParams = PRODUCTION_PARAMS,
): CatchCrossTrigger | null {
  const n = candles.length;
  const i = n - 1;
  if (n < 30) return null;
  const base = computeXys(candles, p);
  const fPrev = base.xys1[i - 1];
  const sPrev = base.xys2[i - 1];
  if (!isNum(fPrev) || !isNum(sPrev) || fPrev === sPrev) return null;
  const side: 'gold' | 'dead' = fPrev < sPrev ? 'gold' : 'dead';

  const today = candles[i];
  const prevClose = candles[i - 1].close;
  if (!isNum(prevClose) || prevClose <= 0) return null;

  // 快慢線差 d(P)：把今天收盤假設成 P（高低點跟著外擴）重算 XYS。d 對 P 嚴格單調遞增。
  const head = candles.slice(0, i);
  const evalAt = (P: number): { d: number; fast: number } => {
    const sim = head.concat([{ ...today, close: P, high: Math.max(today.high, P), low: Math.min(today.low, P) }]);
    const x = computeXys(sim, p);
    return { d: x.xys1[i] - x.xys2[i], fast: x.xys1[i] };
  };

  const lo = prevClose * (1 - limitPct); // 跌停
  const hi = prevClose * (1 + limitPct); // 漲停
  const dLo = evalAt(lo);
  const dHi = evalAt(hi);
  if (!isNum(dLo.d) || !isNum(dHi.d)) return null;

  const dNow = base.xys1[i] - base.xys2[i];
  const crossedNow = side === 'gold' ? dNow > 0 : dNow < 0;

  // 整個漲跌停區間都在同一側 → 不用搜
  if (side === 'gold' && dHi.d <= 0) {
    return { side, price: null, zone: null, pctFromClose: null, reachable: false, crossedNow, always: false };
  }
  if (side === 'dead' && dLo.d >= 0) {
    return { side, price: null, zone: null, pctFromClose: null, reachable: false, crossedNow, always: false };
  }
  if (side === 'gold' && dLo.d > 0) {
    return { side, price: r2(lo), zone: dLo.fast > 0 ? 'bull' : 'bear', pctFromClose: null, reachable: true, crossedNow, always: true };
  }
  if (side === 'dead' && dHi.d < 0) {
    return { side, price: r2(hi), zone: dHi.fast > 0 ? 'bull' : 'bear', pctFromClose: null, reachable: true, crossedNow, always: true };
  }

  // 二分搜臨界價：a 側 d≤0、b 側 d>0（d 單調遞增 ⇒ 括住唯一交點）
  let a = lo, b = hi;
  for (let k = 0; k < 50; k++) {
    const mid = (a + b) / 2;
    if (evalAt(mid).d > 0) b = mid; else a = mid;
  }
  // 金叉要「收在觸發側」＝取 d>0 那側往上取整到分；死叉取 d<0 側往下取整。
  // 取整後可能剛好落回臨界點另一側 → 各推 1 分錢驗證，保證顯示的價位真的會觸發。
  let price: number;
  if (side === 'gold') {
    price = Math.ceil(b * 100) / 100;
    if (evalAt(price).d <= 0) price = r2(price + 0.01);
  } else {
    price = Math.floor(a * 100) / 100;
    if (evalAt(price).d >= 0) price = r2(price - 0.01);
  }
  const at = evalAt(price);
  const zone: 'bull' | 'bear' = at.fast > 0 ? 'bull' : 'bear';
  const pct = isNum(today.close) && today.close > 0 ? r2(((price - today.close) / today.close) * 100) : null;
  return { side, price, zone, pctFromClose: pct, reachable: price >= lo - 1e-9 && price <= hi + 1e-9, crossedNow, always: false };
}
