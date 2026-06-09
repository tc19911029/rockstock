// ============================================================
// 三色資金 — 雙B / XYS 動能 / 捕撈彩柱 的共用「參數化」純函式。
//
// 為什麼抽這支：雙B + XYS 公式原本重複在 indicators.ts(走圖) / conditions.ts(選股) /
//   selectors.ts(A11) / research-sanse-combo.ts(回測) 四個地方，header 註解一直警告「必須同步」。
//   抽成單一來源 + 吃 p: SanSeParams，既消除漂移風險，又是參數搜尋的入口。
//
// ⚠️ byte-identity 鐵律：把字面值換成 p.* 時「只搬不重排算術」。預設 p=PRODUCTION_PARAMS ⇒
//    輸出與重構前逐位元相同（sanse-params-frozen + golden 釘死）。
// ============================================================

import { REF, MA, EMA, HHV, CROSS, add, sub, mul, div, isNum } from './tdx';
import { PRODUCTION_PARAMS, type SanSeParams } from './params';
import type { Candle } from '@/types';

export interface LinePoint { time: string; value: number }
export interface DayExtrasArr { amount: number[]; vol: number[]; turnover: number[] }
/** 捕撈季節量能 4 級彩柱（綠>thr0 / 黃>thr1 / 青>thr2 / 藍>thr3，且 X10>devGate 且動能>0）。 */
export interface XysTiers { green: LinePoint[]; yellow: LinePoint[]; cyan: LinePoint[]; blue: LinePoint[] }

export interface DualBSeries {
  zb4: number[]; zb5: number[]; zhineng: number[]; ma60: number[];
  goldCross: boolean[]; deadCross: boolean[]; breakUp: boolean[]; breakDn: boolean[];
}
export interface XysSeries { xys0: number[]; xys1: number[]; xys2: number[]; goldCross: boolean[]; deadCross: boolean[] }

/**
 * ZB4 線性加權的權重與正規化常數（由 span 推導，正規化常數「非」自由參數）。
 * span=20 ⇒ w[0..18]=20-lag、w[19]=0(原碼跳過)、w[20]=1，sum=210（與原 ZB4_WEIGHTS 逐位元相同）。
 */
export function zb4Weights(span: number): { weights: number[]; norm: number } {
  const w = new Array(span + 1).fill(0);
  for (let lag = 0; lag <= span - 2; lag++) w[lag] = span - lag;
  w[span] = 1;
  const norm = w.reduce((a, b) => a + b, 0);
  return { weights: w, norm };
}

/** 雙B戰法主圖序列（智能交易線 / 黃線 zb4 / 紅線 zb5 / 多空線 + 金叉/死叉/突破/跌破）。 */
export function computeDualB(candles: Candle[], p: SanSeParams = PRODUCTION_PARAMS): DualBSeries {
  const n = candles.length;
  const C = candles.map((c) => c.close);
  const ZB = candles.map((c) => (c.close + c.high + c.open + c.low) / 4);
  const zhineng = mul(HHV(ZB, p.dualB.zhinengHHV), p.dualB.zhinengMult);
  const ZB3 = candles.map((c) => (3 * c.close + c.open + c.low + c.high) / 6);
  const span = p.dualB.zb4Span;
  const { weights, norm } = zb4Weights(span);
  const zb4 = new Array(n).fill(NaN);
  for (let i = span; i < n; i++) {
    let s = 0;
    for (let lag = 0; lag <= span; lag++) s += weights[lag] * ZB3[i - lag];
    zb4[i] = s / norm;
  }
  const zb5 = MA(zb4, p.dualB.zb5Ma);
  const ma60 = MA(C, p.dualB.ma60);
  return {
    zb4, zb5, zhineng, ma60,
    goldCross: CROSS(zb4, zb5),
    deadCross: CROSS(zb5, zb4),
    breakUp: CROSS(C, zhineng),
    breakDn: CROSS(zhineng, C),
  };
}

/** XYS 動能快慢線（捕撈金叉 + 主力 A11 + 走圖副圖共用）。 */
export function computeXys(candles: Candle[], p: SanSeParams = PRODUCTION_PARAMS): XysSeries {
  const C = candles.map((c) => c.close);
  const H = candles.map((c) => c.high);
  const L = candles.map((c) => c.low);
  const e = p.xys.emaLen;
  const X1 = div(add(add(mul(C, 2), H), L), 3);
  const X4 = EMA(EMA(EMA(X1, e), e), e);
  const XYS0 = mul(div(sub(X4, REF(X4, 1)), REF(X4, 1)), 100);
  const xys1 = XYS0;
  const xys2 = MA(XYS0, p.xys.slowMa);
  return {
    xys0: XYS0, xys1, xys2,
    goldCross: CROSS(xys1, xys2),
    deadCross: CROSS(xys2, xys1),
  };
}

/** 捕撈量價強勢 proxy（金叉配爆量）：vol > MA(vol,volMa) × volSurgeMult，逐根布林。 */
export function computeCatchVolSurge(candles: Candle[], p: SanSeParams = PRODUCTION_PARAMS): boolean[] {
  const V = candles.map((c) => c.volume);
  const volMa = MA(V, p.catch.volMa);
  return V.map((v, i) => isNum(volMa[i]) && volMa[i] > 0 && v > volMa[i] * p.catch.volSurgeMult);
}

/** 捕撈季節底部 4 級量能彩柱（需成交額/換手率 extras + XYS1>0）。 */
export function computeTiers(
  candles: Candle[],
  extras: DayExtrasArr,
  xys: XysSeries,
  p: SanSeParams = PRODUCTION_PARAMS,
): XysTiers {
  const n = candles.length;
  const dates = candles.map((c) => c.date);
  const C = candles.map((c) => c.close);
  const X8 = EMA(extras.amount, p.tier.amountEma);
  const X7 = EMA(extras.vol, p.tier.volEma);
  const X9 = div(div(X8, X7), 100);              // EMA(額)/EMA(量)/100 ≈ 平滑成本
  const X10 = mul(div(sub(C, X9), X9), 100);     // 偏離成本 %
  const X11 = EMA(extras.turnover, p.tier.turnoverEma); // 換手率 EMA
  const baseOK = (k: number) => isNum(X10[k]) && isNum(X11[k]) && X10[k] > p.tier.devGate && xys.xys1[k] > 0;
  const tier = (thr: number, h: number): LinePoint[] => {
    const out: LinePoint[] = [];
    for (let k = 0; k < n; k++) if (baseOK(k) && X11[k] > thr) out.push({ time: dates[k], value: h });
    return out;
  };
  const t = p.tier.thresholds;
  return { green: tier(t[0], 2), yellow: tier(t[1], 1.5), cyan: tier(t[2], 1), blue: tier(t[3], 0.5) };
}
