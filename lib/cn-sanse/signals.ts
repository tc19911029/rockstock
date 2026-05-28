// ============================================================
// 三色資金 — 圖表指標的「離散買賣點」評估（給共振系統用）。
//
// 只回最新一根（+ 近 3/5 日）的買賣訊號，輕量、可在全市場掃描內逐檔呼叫。
// 雙B / 捕撈季節 的公式必須與 indicators.ts（畫圖用）一致，否則表格訊號會跟走圖對不上。
// 主力狀態F 不產買賣點（與選股因子同源、會套套邏輯）→ 改回傳三色強度。
// ============================================================

import { REF, MA, EMA, HHV, CROSS, sub, div, mul, add, isNum } from './tdx';
import { computeSanSe, type SanSeSeries } from './selectors';
import type { Candle } from '@/types';

export interface StockSignals {
  // 雙B戰法（黃紅金叉 或 突破智能交易線）
  doubleBBuy: boolean; doubleBBuyW3: boolean; doubleBBuyW5: boolean; doubleBSell: boolean;
  // 捕撈季節（XYS 動能金叉/死叉）
  catchBuy: boolean; catchBuyW3: boolean; catchBuyW5: boolean; catchSell: boolean;
  // 主力狀態F（不計分，顯示策略強度）
  shortAttack: number; midStrength: number; midControl: number; kongPan: number;
  allThreeUp: boolean;   // 三色齊揚（紫紅黃皆 >0）
  zhuliWeak: boolean;    // 主力偏弱（中線強勢 <0）
}

// ZB4 線性加權（與 indicators.ts 同：lag0=20…lag18=2, lag20=1，總和 210）
const ZB4_WEIGHTS = (() => {
  const w = new Array(21).fill(0);
  for (let lag = 0; lag <= 18; lag++) w[lag] = 20 - lag;
  w[20] = 1;
  return w;
})();

const anyWithin = (cond: boolean[], n: number): boolean => cond.slice(-n).some(Boolean);
const r2 = (x: number): number => (isNum(x) ? Math.round(x * 100) / 100 : 0);

/**
 * 算單檔最新一根的圖表指標買賣點。
 * @param series 若已在外部算過 computeSanSe（掃描器會），傳進來免重算
 */
export function evalSignals(candles: Candle[], indexClose?: number[], series?: SanSeSeries): StockSignals {
  const n = candles.length;
  const i = n - 1;
  const O = candles.map((c) => c.open);
  const H = candles.map((c) => c.high);
  const L = candles.map((c) => c.low);
  const C = candles.map((c) => c.close);

  // ── 雙B戰法 ──
  const ZB = candles.map((c) => (c.close + c.high + c.open + c.low) / 4);
  const zhineng = mul(HHV(ZB, 13), 0.95);
  const ZB3 = candles.map((c) => (3 * c.close + c.open + c.low + c.high) / 6);
  const zb4 = new Array(n).fill(NaN);
  for (let k = 20; k < n; k++) {
    let s = 0;
    for (let lag = 0; lag <= 20; lag++) s += ZB4_WEIGHTS[lag] * ZB3[k - lag];
    zb4[k] = s / 210;
  }
  const zb5 = MA(zb4, 6);
  const bBuy = CROSS(zb4, zb5);          // 黃紅金叉
  const bBreakUp = CROSS(C, zhineng);    // 突破智能交易線
  const bSell = CROSS(zb5, zb4);         // 黃紅死叉
  const bBreakDn = CROSS(zhineng, C);    // 跌破智能交易線
  const buyArr = bBuy.map((v, k) => v || bBreakUp[k]);
  const sellArr = bSell.map((v, k) => v || bBreakDn[k]);

  // ── 捕撈季節（XYS 動能） ──
  const X1 = div(add(add(mul(C, 2), H), L), 3);
  const X4 = EMA(EMA(EMA(X1, 3), 3), 3);
  const XYS0 = mul(div(sub(X4, REF(X4, 1)), REF(X4, 1)), 100);
  const XYS1 = XYS0;
  const XYS2 = MA(XYS0, 2);
  const cBuy = CROSS(XYS1, XYS2);
  const cSell = CROSS(XYS2, XYS1);

  // ── 主力狀態F 強度（同選股引擎） ──
  let sa = 0, ms = 0, mc = 0, kp = 0;
  const s = series ?? (indexClose ? computeSanSe(candles, indexClose) : undefined);
  if (s) { sa = r2(s.shortAttack[i]); ms = r2(s.midStrength[i]); mc = r2(s.midControl[i]); kp = r2(s.kongPan[i]); }

  return {
    doubleBBuy: !!buyArr[i], doubleBBuyW3: anyWithin(buyArr, 3), doubleBBuyW5: anyWithin(buyArr, 5), doubleBSell: !!sellArr[i],
    catchBuy: !!cBuy[i], catchBuyW3: anyWithin(cBuy, 3), catchBuyW5: anyWithin(cBuy, 5), catchSell: !!cSell[i],
    shortAttack: sa, midStrength: ms, midControl: mc, kongPan: kp,
    allThreeUp: sa > 0 && ms > 0 && mc > 0,
    zhuliWeak: s ? ms < 0 : false,
  };
}
