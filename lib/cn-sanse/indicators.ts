// ============================================================
// 三色資金 — 圖表指標計算（雙B戰法主圖 + 游資資金副圖）
// 全部 price-only，忠實重現通達信原始碼。
//
// 雙B / XYS / 捕撈彩柱 的數學已抽到 ./dualB（參數化單一來源），這支只做「走圖呈現」
// （上色、箭頭標記、五色線、教學側欄）。computeSanSeChart 維持原簽名、用預設參數 ⇒ 走圖輸出不變。
// ============================================================

import { MA, gt, BARSLAST, isNum } from './tdx';
import { computeSanSe } from './selectors';
import { computeDualB, computeXys, computeTiers, type LinePoint, type DayExtrasArr, type XysTiers } from './dualB';
import { PRODUCTION_PARAMS, cloneParams, CN_TIER_THRESHOLDS, type TierThresholds } from './params';
import type { Candle } from '@/types';

// 型別 / 門檻常數的單一來源已移到 ./dualB 與 ./params；此處 re-export 維持既有 import 路徑相容。
export type { LinePoint, DayExtrasArr, XysTiers } from './dualB';
export { CN_TIER_THRESHOLDS, TW_TIER_THRESHOLDS, type TierThresholds } from './params';

export interface BarPoint { time: string; value: number; color: string }
export interface ChartMarker {
  time: string;
  position: 'aboveBar' | 'belowBar';
  shape: 'arrowUp' | 'arrowDown' | 'circle';
  color: string;
  text: string;
  size?: number; // lightweight-charts marker 大小倍率（預設 1）；放大讓金叉/死叉箭頭更醒目
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
const GREEN_SELL = '#39FF6A'; // 死叉箭頭專用亮綠：比動能<0 綠柱(GREEN)更亮，疊在綠柱/暗背景上才看得清
const MAGENTA = '#FF2EC4';
const YELLOW = '#FFD000';
const RED = '#FF433D';
const BLUE = '#3B82F6';

function lp(dates: string[], arr: number[]): LinePoint[] {
  const out: LinePoint[] = [];
  for (let i = 0; i < arr.length; i++) if (isNum(arr[i])) out.push({ time: dates[i], value: +arr[i].toFixed(3) });
  return out;
}

export function computeSanSeChart(
  candles: Candle[],
  indexClose?: number[],
  extras?: DayExtrasArr,
  tierThr: TierThresholds = CN_TIER_THRESHOLDS,
  limitPct: number = 0.10, // 漲跌停幅度（主板/台股 10%、創業板/科創 20%）→ 決定 K 線漲停/大漲上色門檻
): SanSeChartData {
  const dates = candles.map((c) => c.date);
  const C = candles.map((c) => c.close);
  const n = candles.length;

  // ── 雙B戰法主圖（共用 ./dualB）──────────────────────────────────
  const db = computeDualB(candles);
  const { zb4, zb5, zhineng, ma60: duokong } = db;
  const buy = db.goldCross;          // 黃金交叉（黃上穿紅）→ 紅箭頭向上
  const sell = db.deadCross;         // 死叉（黃下穿紅）→ 綠箭頭向下
  const breakUp = db.breakUp;        // 突破智能線 → 藍 B
  const breakDn = db.breakDn;        // 跌破智能線 → 藍 S
  const breakUpYR = db.breakUpYR;    // 突破紅黃線 → 紅 B
  const breakDnYR = db.breakDnYR;    // 跌破紅黃線 → 紅 S

  const mainMarkers: ChartMarker[] = [];
  for (let i = 0; i < n; i++) {
    // ── 站上線 = B 字母：紅=紅黃線、藍=智能線、紫=同時站上 ──
    const bYR = breakUpYR[i], bSmart = breakUp[i];
    if (bYR && bSmart) mainMarkers.push({ time: dates[i], position: 'belowBar', shape: 'circle', color: PURPLE, text: 'B' });
    else if (bYR) mainMarkers.push({ time: dates[i], position: 'belowBar', shape: 'circle', color: RED, text: 'B' });
    else if (bSmart) mainMarkers.push({ time: dates[i], position: 'belowBar', shape: 'circle', color: BLUE, text: 'B' });
    // ── 跌破線 = S 字母：紅=紅黃線、藍=智能線、紫=同時跌破 ──
    const sYR = breakDnYR[i], sSmart = breakDn[i];
    if (sYR && sSmart) mainMarkers.push({ time: dates[i], position: 'aboveBar', shape: 'circle', color: PURPLE, text: 'S' });
    else if (sYR) mainMarkers.push({ time: dates[i], position: 'aboveBar', shape: 'circle', color: RED, text: 'S' });
    else if (sSmart) mainMarkers.push({ time: dates[i], position: 'aboveBar', shape: 'circle', color: BLUE, text: 'S' });
    // ── 黃紅金叉/死叉 = 箭頭：紅箭頭向上 / 綠箭頭向下（放大更醒目）──
    if (buy[i]) mainMarkers.push({ time: dates[i], position: 'belowBar', shape: 'arrowUp', color: RED, text: '', size: 2 });
    if (sell[i]) mainMarkers.push({ time: dates[i], position: 'aboveBar', shape: 'arrowDown', color: GREEN_SELL, text: '', size: 2 });
  }

  // K線變色（涨停洋紅 / 大漲黃；其餘走 A 股紅漲綠跌預設）
  // 漲停門檻＝幅度 −0.5%（主板 10%→9.5%、創業板/科創 20%→19.5%）；大漲＝7% 到漲停之間。
  const limitThr = limitPct - 0.005;
  const candlesOut: CandlePoint[] = candles.map((c, i) => {
    const pt: CandlePoint = { time: dates[i], open: c.open, high: c.high, low: c.low, close: c.close };
    const prev = i > 0 ? C[i - 1] : NaN;
    if (isNum(prev) && prev > 0) {
      const chg = (c.close - prev) / prev;
      if (chg > limitThr && c.close === c.high) { pt.color = MAGENTA; pt.borderColor = MAGENTA; pt.wickColor = MAGENTA; }
      else if (chg > 0.07 && chg < limitThr) { pt.color = YELLOW; pt.borderColor = YELLOW; pt.wickColor = YELLOW; }
    }
    return pt;
  });

  // ── 游資資金副圖：XYS 動能（共用 ./dualB）─────────────────────
  const xys = computeXys(candles);
  const XYS0 = xys.xys0;
  const XYS1 = xys.xys1;
  const XYS2 = xys.xys2;

  const xys0: BarPoint[] = [];
  for (let i = 0; i < n; i++) {
    if (!isNum(XYS0[i])) continue;
    xys0.push({ time: dates[i], value: +XYS0[i].toFixed(3), color: XYS0[i] >= 0 ? PURPLE : GREEN });
  }

  const goldCross = xys.goldCross;
  const deadCross = xys.deadCross;
  // 只標各「區位」最近一次（多頭區金叉/空頭區金叉/多頭區死叉/空頭區死叉各最多一個字），其餘留箭頭
  const lastWhere = (pred: (k: number) => boolean): number => { for (let k = n - 1; k >= 0; k--) if (pred(k)) return k; return -1; };
  const lGoldBull = lastWhere((k) => !!goldCross[k] && XYS1[k] >= 0);
  const lGoldBear = lastWhere((k) => !!goldCross[k] && XYS1[k] < 0);
  const lDeadBull = lastWhere((k) => !!deadCross[k] && XYS1[k] > 0);
  const lDeadBear = lastWhere((k) => !!deadCross[k] && XYS1[k] <= 0);
  const subMarkers: ChartMarker[] = [];
  for (let i = 0; i < n; i++) {
    if (goldCross[i]) {
      const bull = XYS1[i] >= 0;
      const labeled = bull ? i === lGoldBull : i === lGoldBear;
      subMarkers.push({ time: dates[i], position: 'belowBar', shape: 'arrowUp', color: RED, text: labeled ? (bull ? '多頭區金叉' : '空頭區金叉') : '', size: 2 });
    }
    if (deadCross[i]) {
      const bull = XYS1[i] > 0;
      const labeled = bull ? i === lDeadBull : i === lDeadBear;
      subMarkers.push({ time: dates[i], position: 'aboveBar', shape: 'arrowDown', color: GREEN_SELL, text: labeled ? (bull ? '多頭區死叉' : '空頭區死叉') : '', size: 2 });
    }
  }

  // ── 捕撈季節底部 4 級量能彩柱（需成交額/換手率；共用 ./dualB，門檻逐市場由 tierThr 帶入）─
  let xysTiers: XysTiers | undefined;
  if (extras) {
    const pTier = cloneParams(PRODUCTION_PARAMS);
    pTier.tier.thresholds = tierThr;
    xysTiers = computeTiers(candles, extras, xys, pTier);
  }

  // ── 最後一根的訊號彙整（給教學側欄） ─────────────────────────
  const i = n - 1;
  const buySig: string[] = [];
  const sellSig: string[] = [];
  if (breakUpYR[i]) buySig.push('突破紅黃線（站上紅黃均線帶，紅 B）');
  if (breakUp[i]) buySig.push('突破智能交易線（站上中期支撐，藍 B）');
  if (breakUpYR[i] && breakUp[i]) buySig.push('同時突破紅黃線＋智能線（紫 B，雙線齊站上）');
  if (buy[i]) buySig.push('黃紅雙線金叉（紅箭頭，雙線轉強可持有/加倉）');
  if (goldCross[i]) buySig.push(XYS1[i] < 0 ? '動能空頭區金叉（底部反彈）' : '動能多頭區金叉（趨勢延續）');
  if (breakDnYR[i]) sellSig.push('跌破紅黃線（跌破紅黃均線帶，紅 S）');
  if (breakDn[i]) sellSig.push('跌破智能交易線（跌破中期支撐，藍 S）');
  if (breakDnYR[i] && breakDn[i]) sellSig.push('同時跌破紅黃線＋智能線（紫 S，雙線齊跌破）');
  if (sell[i]) sellSig.push('黃紅雙線死叉（綠箭頭，雙線轉弱離場）');
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
