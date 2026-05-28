// ============================================================
// 三色資金 — 圖表指標計算（雙B戰法主圖 + 游資資金副圖）
// 全部 price-only，忠實重現通達信原始碼。
//
// 略過項目：游資資金副圖的「4 級量能彩柱」需要 AMOUNT(成交額) 且 VOL 單位不明，
//          本地只存 OHLCV，硬湊會標錯色 → 不畫。其餘 100% 重現。
// ============================================================

import { REF, MA, EMA, HHV, CROSS, sub, div, mul, add, gt, BARSLAST, isNum } from './tdx';
import { computeSanSe } from './selectors';
import type { Candle } from '@/types';

export interface LinePoint { time: string; value: number }
export interface BarPoint { time: string; value: number; color: string }
export interface ChartMarker {
  time: string;
  position: 'aboveBar' | 'belowBar';
  shape: 'arrowUp' | 'arrowDown';
  color: string;
  text: string;
}
export interface CandlePoint {
  time: string; open: number; high: number; low: number; close: number;
  color?: string; borderColor?: string; wickColor?: string;
}

export interface SanSeChartData {
  candles: CandlePoint[];
  zhineng: LinePoint[];   // 智能交易線（黃，中期支撐）
  zb4: LinePoint[];       // 黃線（20 日線性加權）
  zb5: LinePoint[];       // 紅線（ZB4 的 MA6）
  duokong: LinePoint[];   // 多空線 MA60
  mainMarkers: ChartMarker[];
  xys0: BarPoint[];       // 動能柱（紫/綠）
  xys1: LinePoint[];      // 動能快線
  xys2: LinePoint[];      // 動能慢線
  subMarkers: ChartMarker[];
  zhuli?: ZhuliSeries;    // 主力狀態F（需大盤指數才算）
  xysTiers?: XysTiers;    // 捕撈季節底部 4 級量能彩柱（需成交額/換手率才算）
  scores?: { shortAttack: number; midStrength: number; midControl: number; kongPan: number };
  latest: LatestSignals;
}

/** 捕撈季節量能 4 級彩柱：綠>6.1 / 黃>3.8 / 青>2.1 / 藍>1.8（換手率 X_11，且 X_10>5 且動能>0） */
export interface XysTiers {
  green: LinePoint[];
  yellow: LinePoint[];
  cyan: LinePoint[];
  blue: LinePoint[];
}

export interface DayExtrasArr { amount: number[]; vol: number[]; turnover: number[] }

/** 主力狀態F 五色線：紅中線主力 / 黃控盤 / 紫短線游資 / 藍短線超跌 / 綠中線超跌 */
export interface ZhuliSeries {
  midStrength: LinePoint[];   // 中線強勢（紅）
  midControl: LinePoint[];    // 中線控盤（黃）
  shortAttack: LinePoint[];   // 短線上攻（紫）
  shortOversold: LinePoint[]; // 短線超跌（藍）
  midOversold: LinePoint[];   // 中線超跌（綠）
}

export interface LatestSignals {
  date: string;
  buy: string[];
  sell: string[];
  trend: string;       // 多空線判斷
  support: string;     // 智能交易線判斷
  dual: string;        // 黃紅雙線
}

const PURPLE = '#8000FF';
const GREEN = '#00CE00';
const MAGENTA = '#FF2EC4';
const YELLOW = '#FFD000';
const RED = '#FF433D';
const BLUE = '#3B82F6';

// 線性加權 ZB4：權重 lag0=20,1=19,...,18=2, lag19=0(原碼跳過), lag20=1，總和 210
const ZB4_WEIGHTS = (() => {
  const w = new Array(21).fill(0);
  for (let lag = 0; lag <= 18; lag++) w[lag] = 20 - lag;
  w[20] = 1;
  return w; // sum = 210
})();

function lp(dates: string[], arr: number[]): LinePoint[] {
  const out: LinePoint[] = [];
  for (let i = 0; i < arr.length; i++) if (isNum(arr[i])) out.push({ time: dates[i], value: +arr[i].toFixed(3) });
  return out;
}

export function computeSanSeChart(candles: Candle[], indexClose?: number[], extras?: DayExtrasArr): SanSeChartData {
  const dates = candles.map((c) => c.date);
  const O = candles.map((c) => c.open);
  const H = candles.map((c) => c.high);
  const L = candles.map((c) => c.low);
  const C = candles.map((c) => c.close);
  const n = candles.length;
  const RECENT = n - 15; // 只在最近 15 根標文字，舊箭頭只留顏色（避免標籤糊成一團）
  const mtext = (i: number, txt: string) => (i >= RECENT ? txt : '');

  // ── 雙B戰法主圖 ──────────────────────────────────────────────
  const ZB = candles.map((c) => (c.close + c.high + c.open + c.low) / 4);
  const zhineng = mul(HHV(ZB, 13), 0.95);
  const ZB3 = candles.map((c) => (3 * c.close + c.open + c.low + c.high) / 6);
  const zb4 = new Array(n).fill(NaN);
  for (let i = 20; i < n; i++) {
    let s = 0;
    for (let lag = 0; lag <= 20; lag++) s += ZB4_WEIGHTS[lag] * ZB3[i - lag];
    zb4[i] = s / 210;
  }
  const zb5 = MA(zb4, 6);
  const duokong = MA(C, 60);

  const buy = CROSS(zb4, zb5);          // 黃紅雙線金叉
  const sell = CROSS(zb5, zb4);         // 黃紅雙線死叉
  const breakUp = CROSS(C, zhineng);    // 突破智能交易線
  const breakDn = CROSS(zhineng, C);    // 跌破智能交易線

  const mainMarkers: ChartMarker[] = [];
  for (let i = 0; i < n; i++) {
    // B/S = 黃紅雙線金叉/死叉（紅 B 買、綠 S 賣，與 App 一致）；標在每根（不只最近）
    if (buy[i]) mainMarkers.push({ time: dates[i], position: 'belowBar', shape: 'arrowUp', color: RED, text: 'B' });
    if (sell[i]) mainMarkers.push({ time: dates[i], position: 'aboveBar', shape: 'arrowDown', color: GREEN, text: 'S' });
    // 突破/跌破智能交易線（另一組訊號）
    if (breakUp[i]) mainMarkers.push({ time: dates[i], position: 'belowBar', shape: 'arrowUp', color: YELLOW, text: mtext(i, '突破') });
    if (breakDn[i]) mainMarkers.push({ time: dates[i], position: 'aboveBar', shape: 'arrowDown', color: BLUE, text: mtext(i, '跌破') });
  }

  // K線變色（涨停洋紅 / 大漲黃；其餘走 A 股紅漲綠跌預設）
  const candlesOut: CandlePoint[] = candles.map((c, i) => {
    const pt: CandlePoint = { time: dates[i], open: c.open, high: c.high, low: c.low, close: c.close };
    const prev = i > 0 ? C[i - 1] : NaN;
    if (isNum(prev) && prev > 0) {
      const chg = (c.close - prev) / prev;
      if (chg > 0.095 && c.close === c.high) { pt.color = MAGENTA; pt.borderColor = MAGENTA; pt.wickColor = MAGENTA; }
      else if (chg > 0.07 && chg < 0.095) { pt.color = YELLOW; pt.borderColor = YELLOW; pt.wickColor = YELLOW; }
    }
    return pt;
  });

  // ── 游資資金副圖：XYS 動能 ───────────────────────────────────
  const X1 = div(add(add(mul(C, 2), H), L), 3);
  const X4 = EMA(EMA(EMA(X1, 3), 3), 3);
  const XYS0 = mul(div(sub(X4, REF(X4, 1)), REF(X4, 1)), 100);
  const XYS1 = XYS0;
  const XYS2 = MA(XYS0, 2);

  const xys0: BarPoint[] = [];
  for (let i = 0; i < n; i++) {
    if (!isNum(XYS0[i])) continue;
    xys0.push({ time: dates[i], value: +XYS0[i].toFixed(3), color: XYS0[i] >= 0 ? PURPLE : GREEN });
  }

  const goldCross = CROSS(XYS1, XYS2);
  const deadCross = CROSS(XYS2, XYS1);
  const subMarkers: ChartMarker[] = [];
  for (let i = 0; i < n; i++) {
    if (goldCross[i]) {
      const zone = XYS1[i] < 0 ? '空頭區金叉' : '多頭區金叉';
      subMarkers.push({ time: dates[i], position: 'belowBar', shape: 'arrowUp', color: RED, text: mtext(i, zone) });
    }
    if (deadCross[i]) {
      const zone = XYS1[i] > 0 ? '多頭區死叉' : '空頭區死叉';
      subMarkers.push({ time: dates[i], position: 'aboveBar', shape: 'arrowDown', color: GREEN, text: mtext(i, zone) });
    }
  }

  // ── 捕撈季節底部 4 級量能彩柱（需成交額/換手率）─────────────
  let xysTiers: XysTiers | undefined;
  if (extras) {
    const X8 = EMA(extras.amount, 13);
    const X7 = EMA(extras.vol, 13);
    const X9 = div(div(X8, X7), 100);              // EMA(額)/EMA(量)/100 ≈ 平滑成本
    const X10 = mul(div(sub(C, X9), X9), 100);     // 偏離成本 %
    const X11 = EMA(extras.turnover, 13);          // 換手率 EMA
    const baseOK = (k: number) => isNum(X10[k]) && isNum(X11[k]) && X10[k] > 5 && XYS1[k] > 0;
    const tier = (thr: number, h: number): LinePoint[] => {
      const out: LinePoint[] = [];
      for (let k = 0; k < n; k++) if (baseOK(k) && X11[k] > thr) out.push({ time: dates[k], value: h });
      return out;
    };
    xysTiers = { green: tier(6.1, 2), yellow: tier(3.8, 1.5), cyan: tier(2.1, 1), blue: tier(1.8, 0.5) };
  }

  // ── 最後一根的訊號彙整（給教學側欄） ─────────────────────────
  const i = n - 1;
  const buySig: string[] = [];
  const sellSig: string[] = [];
  if (buy[i]) buySig.push('黃紅雙線金叉（雙線轉強，可持有/加倉）');
  if (breakUp[i]) buySig.push('突破智能交易線（站上中期支撐，加倉訊號）');
  if (goldCross[i]) buySig.push(XYS1[i] < 0 ? '動能空頭區金叉（底部反彈）' : '動能多頭區金叉（趨勢延續）');
  if (sell[i]) sellSig.push('黃紅雙線死叉（雙線轉弱，離場）');
  if (breakDn[i]) sellSig.push('跌破智能交易線（跌破中期支撐，減倉）');
  if (deadCross[i]) sellSig.push(XYS1[i] > 0 ? '動能多頭區死叉（短期見頂）' : '動能空頭區死叉（下跌加速）');

  // ── 主力狀態F（需大盤指數）：複用選股引擎的三色分數 + 補兩條超跌 ──
  let zhuli: ZhuliSeries | undefined;
  let scores: SanSeChartData['scores'];
  if (indexClose) {
    const s = computeSanSe(candles, indexClose);
    const r2 = (x: number) => (isNum(x) ? Math.round(x * 100) / 100 : 0);
    scores = {
      shortAttack: r2(s.shortAttack[i]),
      midStrength: r2(s.midStrength[i]),
      midControl: r2(s.midControl[i]),
      kongPan: r2(s.kongPan[i]),
    };
    const ma20 = MA(C, 20);
    const ma60 = MA(C, 60);
    const bl20 = BARSLAST(gt(C, ma20));
    const bl60 = BARSLAST(gt(C, ma60));
    const VAR3 = candles.map((c) => (c.close > c.open ? (c.open - c.low) / c.open : (c.close - c.low) / c.open));
    const VAR4 = candles.map((c) => (c.close > c.open ? (c.high - c.close) / c.open : (c.high - c.open) / c.open));
    const shortOver = new Array(n).fill(0);
    const midOver = new Array(n).fill(0);
    for (let k = 0; k < n; k++) {
      if (isNum(bl60[k])) {
        const lag = Math.min(120, bl60[k]);
        if (k - lag >= 0 && C[k] > 0) midOver[k] = ((C[k - lag] - C[k]) / C[k]) * 2;
      }
      if (isNum(ma20[k]) && C[k] < ma20[k] && isNum(bl20[k])) {
        const lag = Math.min(34, bl20[k]);
        if (lag >= 1 && k - lag >= 0) {
          const base = C[k - lag];
          let s3 = 0, s4 = 0;
          for (let j = k - lag + 1; j <= k; j++) { s3 += VAR3[j]; s4 += VAR4[j]; }
          if (base > 0) shortOver[k] = ((base - C[k]) / base + s3 - s4) * 20;
        }
      }
    }
    zhuli = {
      midStrength: lp(dates, s.midStrength),
      midControl: lp(dates, s.midControl),
      shortAttack: lp(dates, s.shortAttack),
      shortOversold: lp(dates, shortOver),
      midOversold: lp(dates, midOver),
    };
  }

  const trend = isNum(duokong[i])
    ? (C[i] > duokong[i] ? '多頭（收盤在 60 日多空線之上，可順勢做多）' : '空頭（收盤在 60 日多空線之下，不宜逆勢）')
    : '資料不足';
  const support = isNum(zhineng[i])
    ? (C[i] > zhineng[i] ? '在智能交易線之上（中期支撐有效）' : '跌破智能交易線（支撐失守）')
    : '資料不足';
  const dual = isNum(zb4[i]) && isNum(zb5[i])
    ? (zb4[i] > zb5[i] ? '黃線在紅線之上（多方）' : '黃線在紅線之下（空方）')
    : '資料不足';

  return {
    candles: candlesOut,
    zhineng: lp(dates, zhineng),
    zb4: lp(dates, zb4),
    zb5: lp(dates, zb5),
    duokong: lp(dates, duokong),
    mainMarkers,
    xys0,
    xys1: lp(dates, XYS1),
    xys2: lp(dates, XYS2),
    subMarkers,
    zhuli,
    xysTiers,
    scores,
    latest: { date: dates[i], buy: buySig, sell: sellSig, trend, support, dual },
  };
}
