// ============================================================
// 三色資金 — 三個選股器引擎（陸股 / A股，自訂策略，與朱家泓書本選股隔離）
//
// 三段通達信原始碼翻譯，共用同一批分數：
//   短线上攻 (游资资金) / 中线强势 (主力资金) / 中线控盘 (主力控盘) / 控盘程度
//
//   嚴(strict / 三色资金共振): 短线上攻>2.8 且 中线强势>3.9 且 中线控盘>0
//                              + A11金叉 + A2牛熊線 + A3控盘>80 + A4剛啟動 + A5洗過盤 + A7持續控盤
//   中(medium / 更新版):        三個分數都 > 0.01
//   寬(loose / 游资资金翻正):    短线上攻 今天>0 且 昨天<=0（剛翻正）
//
// 所有魔術數字收進 SanSeParams（params.ts）；不帶 p ⇒ PRODUCTION_PARAMS ⇒ byte-identical。
// XYS 動能（A11 用）共用 ./dualB，與走圖/條件層同源。
// 板塊排除（A6 + 用戶追加）：688/8/4(科創/北交) + 30(創業板) + ST(股名) 在 universe 層處理。
// ============================================================

import {
  REF, MA, SMA, HHV, LLV, SUM, COUNT, BARSLAST,
  add, sub, mul, div, IFF, gt, lt, and, isNum,
} from './tdx';
import { computeXys } from './dualB';
import { PRODUCTION_PARAMS, type SanSeParams } from './params';
import type { Candle } from '@/types';

export type SanSeLevel = 'strict' | 'medium' | 'loose';

export interface SanSeSeries {
  dates: string[];
  shortAttack: number[];   // 短线上攻 / 游资资金
  midStrength: number[];   // 中线强势 / 主力资金
  midControl: number[];    // 中线控盘 / 主力控盘
  kongPan: number[];       // 控盘程度
  shortOversold: number[]; // 短线超跌（跌破 MA20 後的超跌幅度，與 indicators.ts 同式）
  // 選股結果（逐根）
  strict: boolean[];
  medium: boolean[];
  loose: boolean[];
}

const geNum = (a: number[], n: number): boolean[] => a.map((x) => isNum(x) && x >= n);
const leNum = (a: number[], n: number): boolean[] => a.map((x) => isNum(x) && x <= n);

/**
 * 計算三色資金全部分數與三種選股結果（逐根）。
 * @param candles 個股日K（時間升冪）
 * @param indexClose 與 candles 等長、按日期對齊的大盤指數收盤（上證 000001.SS）
 * @param capital 流通股本（股數）；多數股票有足夠歷史時用不到，可傳 NaN
 * @param p 指標參數；不帶 ⇒ PRODUCTION_PARAMS（與重構前 byte-identical）
 */
export function computeSanSe(
  candles: Candle[],
  indexClose: number[],
  capital = NaN,
  p: SanSeParams = PRODUCTION_PARAMS,
): SanSeSeries {
  const n = candles.length;
  const high = candles.map((c) => c.high);
  const low = candles.map((c) => c.low);
  const close = candles.map((c) => c.close);
  const vol = candles.map((c) => c.volume);
  const dates = candles.map((c) => c.date);

  // ── VAR1：陰線跌幅（負值），其餘為 0 ──────────────────────────
  const var1 = candles.map((c) => (c.close < c.open ? (c.close - c.open) / c.open : 0));

  // ── 短线上攻（游资资金） ───────────────────────────────────────
  const ma5 = MA(close, p.sa.maShort);
  const var9 = mul(MA(low, p.sa.ma20), p.sa.ma20Mult);
  const condA = lt(BARSLAST(gt(close, var9)), p.sa.recentGate);          // 近4根內剛站上 MA20*1.1
  const condB = gt(close, ma5);                                         // 收盤 > MA5
  const hhvClose21 = HHV(close, p.sa.hhvClose);
  const isClose21High = close.map((c, i) => isNum(hhvClose21[i]) && c >= hhvClose21[i]);
  const condC = lt(BARSLAST(isClose21High), p.sa.recentGate);           // 近4根內創21日收盤新高
  const ma5slope = mul(div(sub(ma5, REF(ma5, 1)), REF(ma5, 1)), p.sa.slopeMult);
  const shortAttack = IFF(and(condA, condB, condC), ma5slope, 0);

  // ── 中线强势（主力资金）＝剔除大盤同步後的相對強弱 ─────────────
  const ma240c = MA(close, p.ms.ma240);
  const idxRel = MA(sub(div(indexClose, MA(indexClose, p.ms.ma240)), 1), p.ms.idxSmooth); // MA(INDEXC/MA(INDEXC,240)-1, 3)
  const stockOver = sub(div(close, ma240c), 1);                       // CLOSE/MA(CLOSE,240)-1
  const denom = sub(add(1, stockOver), idxRel);                      // 1 + stockOver - idxRel
  const var12 = div(close, denom);
  const midStrength = mul(sub(div(close, var12), 1), p.ms.mult);

  // ── 中线控盘（主力控盘） ───────────────────────────────────────
  const cnt250 = COUNT(gt(close, 0), p.mc.cnt);
  const sumVol480 = SUM(vol, p.mc.sumVol);
  const var7 = cnt250.map((c, i) => (isNum(c) && c < p.mc.cntGate ? capital : sumVol480[i] / p.mc.sumVolDiv));
  const dev240 = div(sub(close, ma240c), ma240c);     // (CLOSE-MA240)/MA240
  const term = add(dev240, SUM(var1, p.mc.sumVar1));  // + SUM(VAR1,20)
  const maVolVar7 = MA(div(vol, var7), p.mc.volMaLen);
  // 防呆：近乎停牌股（近 20 日量遠低於 480 日均量）→ maVolVar7 趨近 0（甚至浮點負噪 ~-1e-18）
  // → term/maVolVar7 炸成天文數字（實例 6236/6884 衝到 ~1e15）。分母低於 DENOM_FLOOR 視為
  // 「無有效成交、無主力參與」→ 該根 midControl 貢獻為 0。門檻 1e-4 ≈ 近期量 < 480 日均量的 ~0.6%；
  // 正常交易股 maVolVar7 ≥ 1e-3，完全不受影響（全市場僅 7 檔近停牌股的近零量 bar 受此防呆）。
  const DENOM_FLOOR = p.mc.denomFloor;
  const innerVal = term.map((t, i) =>
    isNum(t) && isNum(maVolVar7[i]) && maVolVar7[i] > DENOM_FLOOR ? t / maVolVar7[i] / p.mc.div2 : 0,
  );
  const ctrlCond = and(gt(close, ma240c), gt(term, 0));
  const midControl = MA(IFF(ctrlCond, innerVal, 0), p.mc.smaLen);

  // ── 控盘程度 ───────────────────────────────────────────────────
  const hhvH35 = HHV(high, p.kp.hhvllv);
  const llvL35 = LLV(low, p.kp.hhvllv);
  const rng35 = sub(hhvH35, llvL35);
  const b1 = sub(mul(div(sub(hhvH35, close), rng35), 100), p.kp.b1Offset);
  const b2 = add(SMA(b1, p.kp.sma1N, 1), 100);
  const b3 = mul(div(sub(close, llvL35), rng35), 100);
  const b4 = SMA(b3, p.kp.smaFastN, 1);
  const b5 = add(SMA(b4, p.kp.smaFast2N, 1), 100);
  const b6 = sub(b5, b2);
  const kongPan = mul(IFF(gt(b6, p.kp.gate), sub(b6, p.kp.gate), 0), p.kp.mult);

  // ── 短线超跌（跌破 MA20 後的超跌幅度，與 indicators.ts computeSanSeChart 同式）──
  const ma20 = MA(close, 20);
  const bl20 = BARSLAST(gt(close, ma20));
  const VAR3 = candles.map((c) => (c.close > c.open ? (c.open - c.low) / c.open : (c.close - c.low) / c.open));
  const VAR4 = candles.map((c) => (c.close > c.open ? (c.high - c.close) / c.open : (c.high - c.open) / c.open));
  const shortOversold = new Array(n).fill(0) as number[];
  for (let k = 0; k < n; k++) {
    if (isNum(ma20[k]) && close[k] < ma20[k] && isNum(bl20[k])) {
      const lag = Math.min(34, bl20[k]);
      if (lag >= 1 && k - lag >= 0) {
        const base = close[k - lag];
        let s3 = 0, s4 = 0;
        for (let j = k - lag + 1; j <= k; j++) { s3 += VAR3[j]; s4 += VAR4[j]; }
        if (base > 0) shortOversold[k] = ((base - close[k]) / base + s3 - s4) * 20;
      }
    }
  }

  // ── XYS 動能快慢線 + A11 金叉（共用 ./dualB）─────────────────────
  const xs = computeXys(candles, p);
  const countGold5 = COUNT(xs.goldCross, p.xys.countGoldN);
  const countDead4 = COUNT(xs.deadCross, p.xys.countDeadN);
  const A11 = countGold5.map((g, i) => isNum(g) && g >= 1 && isNum(countDead4[i]) && countDead4[i] <= 1);

  // ── A2：站上牛線與熊線（FORCAST N=2 ＝ 當前值，故直接取 LLV/HHV） ─
  const bull = LLV(mul(close, p.gates.bullMult), p.gates.bullBearHHVLLV);
  const bear = HHV(mul(close, p.gates.bearMult), p.gates.bullBearHHVLLV);
  const A2 = and(gt(close, bull), gt(close, bear));

  // ── A3 / A4 / A5 / A7 ──────────────────────────────────────────
  const A3 = gt(kongPan, p.gates.a3KongPan);
  const A4 = lt(REF(shortAttack, 1), p.gates.a4Recent);                  // 昨天剛啟動
  const A5 = geNum(COUNT(lt(midStrength, 0), p.gates.a5CountN), 1);      // 近50天曾洗盤
  const kongZero = kongPan.map((k) => k === 0);
  const A7 = leNum(COUNT(kongZero, p.gates.a7CountN), p.gates.a7CountMax); // 近30天持續控盤

  // ── 三種選股結果 ───────────────────────────────────────────────
  const strict = Array.from({ length: n }, (_, i) =>
    shortAttack[i] > p.level.strictSA && midStrength[i] > p.level.strictMS && midControl[i] > p.level.strictMC &&
    A11[i] && A2[i] && A3[i] && A4[i] && A5[i] && A7[i],
  );
  const medium = Array.from({ length: n }, (_, i) =>
    shortAttack[i] > p.level.mediumEps && midStrength[i] > p.level.mediumEps && midControl[i] > p.level.mediumEps,
  );
  const loose = Array.from({ length: n }, (_, i) =>
    shortAttack[i] > 0 && isNum(REF(shortAttack, 1)[i]) && REF(shortAttack, 1)[i] <= 0,
  );

  return { dates, shortAttack, midStrength, midControl, kongPan, shortOversold, strict, medium, loose };
}

/** 取某一根（預設最後一根）是否命中指定嚴格度，附當根四個分數。 */
export function evalLatest(series: SanSeSeries, level: SanSeLevel, idx = -1) {
  const i = idx < 0 ? series.dates.length - 1 : idx;
  return {
    date: series.dates[i],
    hit: series[level][i],
    shortAttack: round(series.shortAttack[i]),
    midStrength: round(series.midStrength[i]),
    midControl: round(series.midControl[i]),
    kongPan: round(series.kongPan[i]),
    shortOversold: round(series.shortOversold[i]),
  };
}

const round = (x: number): number => (isNum(x) ? Math.round(x * 100) / 100 : 0);
