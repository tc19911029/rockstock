/**
 * 做空 7 個進場位置偵測（課程 CH6-8 ~ CH6-14，2026-07-05 批次C）
 *
 * 大工程-1 啟動：與做多 7 位置互為鏡像。判準抄各節投影片原文（引註在各 detector）：
 *   S1 彈後空下跌（6-8）    — 空頭反彈未過前高，中長黑跌破前日低+破5均，月線下向下【量不要求】
 *   S2 盤整的跌破（6-9）    — 橫向盤整後中長黑收盤跌破下頸線，月線下向下
 *   S3 K線橫盤的跌破（6-10）— 卡在中長黑K高低點間橫盤，中長黑收盤跌破橫盤最低點
 *   S4 型態確認賣點（6-11） — 頭部型態大量中長黑跌破頸線×3%（課程六型優先，雙重頂為舊書補充）
 *   S5 ABC反彈跌破上升切線（6-12）— 空頭反彈 ABC 短多，黑K跌破原始上升切線，月線下向下【量不要求】
 *   S6 跌破下跌軌道線（6-13）— 下降通道緩跌，大量中長黑收盤跌破軌道線，MA20 向下【明確要大量】
 *   S7 飆股反彈紅K低點跌破（6-14）— 下跌飆股反彈紅K後 3 天內中長黑收盤破紅K低點；最新講義量能選配
 *
 * 共同紀律（每節投影片都有）：停損（回補）= 進場黑K最高點；站上 5 均回補。
 * 出場側已上線（evaluateShortHolding / detectShortExitSignals），本模組只補「進場」。
 *
 * 2026-08-06：S1–S7 已接入正式做空掃描；六條件保留為品質分數，不再用全域大量條件
 * 擋掉 S1/S5/S7 這些課程明訂量不要求或最新講義量選配的進場位置。
 *
 * S4 頂部型態 v2（2026-07-07 補齊）：三重頂/頭肩頂/雙重頂 + 複式頭肩頂/倒N字頂/長雙頭頂/一字頂 共 7 型
 * （detectTopPatterns 內；線上課沒有公布這 7 型的精確達標率，程式不顯示對稱估值）。
 */

import type { CandleWithIndicators } from '@/types';
import { detectTrend, findPivots } from './trendAnalysis';
import { detectTopPatterns } from './v12LetterN';
import { BOOK_VOL_RATIO_MIN } from './bookThresholds';

export type ShortEntryPosition = 1 | 2 | 3 | 4 | 5 | 6 | 7;

export interface ShortEntrySignal {
  position: ShortEntryPosition;
  id: string;
  name: string;
  /** 停損（回補）＝進場黑K最高點（各節投影片共同紀律） */
  stopLoss: number;
  /** 型態目標價（S4 才有） */
  targetPrice?: number;
  volumeRatio: number | null;
  /** 量 ≥ 前日 ×1.3（S1/S5 課程明講量不要求 → 純記錄；S6 課程明確要大量 → gate） */
  hasVolume: boolean;
  /** 同一課題有來源版本差異時，記錄本次採用的裁決。 */
  sourceVariant?: 'latest_handout_volume_optional';
  detail: string;
}

const MIN_BODY_PCT = 0.02;          // 中長黑實體 ≥2%（與做多側 BOOK_BODY_PCT_MIN 對稱）
const ANCHOR_BODY_PCT = 0.03;       // S3 錨點中長K實體 ≥3%（鏡像 KLINE_CONSOL_ANCHOR_BODY_PCT）
const CONSOL_MIN_BARS = 3;          // S3 突破前至少 3 根（含錨點；最新講義「連續三天」）
const CONSOL_MAX_BARS = 15;
const CONSOL_MAX_RANGE = 0.05;      // S3 狹幅 5%（鏡像做多側）
const PLUNGE_PCT = -0.20;           // S7 下跌飆股：近20根累跌 >20%（⚠️ 課程「連續急跌」無數字，鏡像 L 軌 20%）

function isMedLongBlackBar(c: CandleWithIndicators): boolean {
  return c.open > 0 && c.close < c.open && (c.open - c.close) / c.open >= MIN_BODY_PCT;
}

/** 月線之下 + 月線向下（6-9/6-12/6-13 投影片共同硬前提「月線之上不做空」） */
function belowFallingMa20(candles: CandleWithIndicators[], idx: number): boolean {
  const c = candles[idx];
  const prev = candles[idx - 1];
  return c.ma20 != null && c.close < c.ma20
    && (prev?.ma20 == null || c.ma20 <= prev.ma20);
}

function volInfo(candles: CandleWithIndicators[], idx: number): { ratio: number | null; has: boolean } {
  const c = candles[idx], prev = candles[idx - 1];
  if (!prev || prev.volume <= 0) return { ratio: null, has: false };
  const ratio = c.volume / prev.volume;
  return { ratio, has: ratio >= BOOK_VOL_RATIO_MIN };
}

/** 跳空下跌 tag（課程 6-8/6-9/6-11/6-12：「當天若是跳空下跌的中長黑，力道更強、更要把握」）— 做空側顯示補齊 */
function gapDownTag(candles: CandleWithIndicators[], idx: number): string {
  const c = candles[idx], prev = candles[idx - 1];
  return prev && c.open > 0 && c.open < prev.close ? '｜跳空下跌力道更強' : '';
}

/** 某根紅K是否為「大量紅K」（相對其前 5 根均量 ≥1.3；資料不足時放行）— S7 反彈紅K用（課程 6-14「大量紅K反彈」） */
function isBigVolRedBar(candles: CandleWithIndicators[], j: number): boolean {
  const r = candles[j];
  if (!(r.close > r.open)) return false;
  const prior = candles.slice(Math.max(0, j - 5), j);
  if (prior.length < 3) return true; // 資料不足不擋
  const avg = prior.reduce((s, x) => s + x.volume, 0) / prior.length;
  return avg <= 0 || r.volume >= avg * 1.3;
}

/** S1 彈後空下跌（6-8）：空頭反彈未過前高 → 中長黑破前日低＋破5均，月線下向下；量不要求 */
function detectS1ReboundShort(candles: CandleWithIndicators[], idx: number): ShortEntrySignal | null {
  const c = candles[idx], prev = candles[idx - 1];
  if (!prev || !isMedLongBlackBar(c)) return null;
  if (c.ma5 == null || c.close >= c.ma5) return null;          // 跌破5日線
  if (c.close >= prev.low) return null;                        // 跌破前日低點
  if (!belowFallingMa20(candles, idx)) return null;            // 月線之下（向下的月線）
  if (detectTrend(candles, idx) !== '空頭') return null;
  // 近 8 根內存在「反彈」（收盤曾站上 MA5）— 有彈才有「彈後空」
  let hadRebound = false;
  for (let j = Math.max(1, idx - 8); j < idx; j++) {
    const b = candles[j];
    if (b.ma5 != null && b.close > b.ma5) { hadRebound = true; break; }
  }
  if (!hadRebound) return null;
  const v = volInfo(candles, idx);
  return {
    position: 1, id: 'S1_rebound_short', name: '彈後空下跌',
    stopLoss: c.high, volumeRatio: v.ratio, hasVolume: v.has,
    detail: `空頭反彈未過前高，中長黑收 ${c.close.toFixed(2)} 破前日低 ${prev.low.toFixed(2)}＋破5均（課程 6-8；量不要求）${gapDownTag(candles, idx)}`,
  };
}

/** S2 盤整的跌破（6-9）：兩低點連線=下頸線，中長黑首次收盤跌破；月線下向下 */
function detectS2RangeBreakdown(candles: CandleWithIndicators[], idx: number): ShortEntrySignal | null {
  const c = candles[idx], prev = candles[idx - 1];
  if (!prev || !isMedLongBlackBar(c)) return null;
  if (!belowFallingMa20(candles, idx)) return null;
  if (detectTrend(candles, idx) === '多頭') return null;
  const pivots = findPivots(candles, idx, 8);
  const highs = pivots.filter(p => p.type === 'high').slice(0, 2);
  const lows = pivots.filter(p => p.type === 'low').slice(0, 2);
  if (highs.length < 2 || lows.length < 2) return null;
  // 盤整＝下頸線近平（兩低相差 ≤5%）且區間寬 ≤12%（⚠️ 容差自訂，課程只畫圖）
  const [lNew, lOld] = lows;
  if (Math.abs(lNew.price - lOld.price) / lOld.price > 0.05) return null;
  const upper = Math.max(highs[0].price, highs[1].price);
  const lower = Math.min(lNew.price, lOld.price);
  if (lower <= 0 || (upper - lower) / lower > 0.12) return null;
  // 下頸線線性插值，首次跌破
  const at = (i: number) => lOld.price + (lNew.price - lOld.price) * (i - lOld.index) / Math.max(1, lNew.index - lOld.index);
  if (prev.close < at(idx - 1)) return null;                   // 昨天還沒破 → 今天是首破
  if (c.close >= at(idx)) return null;
  const v = volInfo(candles, idx);
  return {
    position: 2, id: 'S2_range_breakdown', name: '盤整的跌破',
    stopLoss: c.high, volumeRatio: v.ratio, hasVolume: v.has,
    detail: `中長黑收 ${c.close.toFixed(2)} 首次跌破盤整下頸線 ${at(idx).toFixed(2)}（課程 6-9；月線下向下${v.has ? '＋大量' : ''}）${gapDownTag(candles, idx)}`,
  };
}

/** S3 K線橫盤的跌破（6-10）：中長黑K錨點高低區間橫盤 ≥3 根 → 中長黑收盤跌破橫盤最低點 */
function detectS3KlineConsolBreakdown(candles: CandleWithIndicators[], idx: number): ShortEntrySignal | null {
  const c = candles[idx];
  if (!isMedLongBlackBar(c)) return null;
  if (c.ma20 == null || c.close >= c.ma20) return null;        // 下跌途中/破月線後
  for (let gap = CONSOL_MIN_BARS; gap <= CONSOL_MAX_BARS; gap++) {
    const aIdx = idx - gap;
    if (aIdx < 1) break;
    const a = candles[aIdx];
    if (a.open <= 0) continue;
    if ((a.open - a.close) / a.open < ANCHOR_BODY_PCT) continue;   // 錨點＝中長黑（課程 6-10「卡在中長黑K高低點之間」）
    // 錨點次日..昨日收盤都在錨點高低之間
    let ok = true, minLow = a.low;
    for (let j = aIdx + 1; j < idx; j++) {
      const b = candles[j];
      if (b.close > a.high || b.close < a.low) { ok = false; break; }
      if (b.low < minLow) minLow = b.low;
    }
    if (!ok) continue;
    if ((a.high - minLow) / Math.max(1e-9, minLow) > CONSOL_MAX_RANGE + ((a.high - a.low) / a.low)) continue; // 狹幅
    if (c.close >= minLow) continue;                           // 收盤跌破橫盤最低點（支撐線）
    const v = volInfo(candles, idx);
    return {
      position: 3, id: 'S3_kline_consol_breakdown', name: 'K線橫盤的跌破',
      stopLoss: c.high, volumeRatio: v.ratio, hasVolume: v.has,
      detail: `含錨點橫盤 ${gap} 根後中長黑收 ${c.close.toFixed(2)} 跌破橫盤最低 ${minLow.toFixed(2)}（課程 6-10；最新講義口徑）`,
    };
  }
  return null;
}

/** S4 型態確認賣點（6-11）：重用 detectTopPatterns（黑K+實體2%+量1.3+頸線×3% 真跌破，附目標價） */
function detectS4TopPattern(candles: CandleWithIndicators[], idx: number): ShortEntrySignal | null {
  const r = detectTopPatterns(candles, idx);
  if (!r.triggered || r.necklinePrice == null) return null;
  const c = candles[idx];
  const v = volInfo(candles, idx);
  return {
    position: 4, id: 'S4_top_pattern', name: `型態確認賣點（${r.patternType}）`,
    stopLoss: c.high, targetPrice: r.patternTargetPrice,
    volumeRatio: v.ratio, hasVolume: v.has,
    detail: `${r.detail}（課程 6-11；型態目標價 ${r.patternTargetPrice?.toFixed(2) ?? '—'}）`,
  };
}

/** S5 ABC反彈跌破上升切線（6-12）：空頭跌波後 ABC 反彈（短多），黑K跌破兩低點連的上升切線；量不要求 */
function detectS5AbcBreakdown(candles: CandleWithIndicators[], idx: number): ShortEntrySignal | null {
  const c = candles[idx];
  if (!isMedLongBlackBar(c)) return null;
  if (!belowFallingMa20(candles, idx)) return null;
  const pivots = findPivots(candles, idx, 8);
  if (pivots.length < 4) return null;
  // 由近至遠列舉反彈頂 C 高，往前組 B低 / A高 / A低（鏡像 findABCStructures）
  for (const legC of pivots) {
    if (legC.type !== 'high') continue;
    const legB = pivots.find(p => p.type === 'low' && p.index < legC.index);
    if (!legB) continue;
    const legA = pivots.find(p => p.type === 'high' && p.index < legB.index);
    if (!legA) continue;
    const legALow = pivots.find(p => p.type === 'low' && p.index < legA.index);
    if (!legALow) continue;
    // 反彈結構：頭頭高（legC > legA）+ 底底高（legB > legALow）＝短多
    if (legC.price <= legA.price) continue;
    if (legB.price <= legALow.price) continue;
    // 反彈之前是空頭（鏡像「修正之前是多頭」）
    if (detectTrend(candles, legALow.index) !== '空頭') continue;
    // 上升切線＝legALow → legB 兩個低點連線，今日收盤跌破延伸值
    const slope = (legB.price - legALow.price) / Math.max(1, legB.index - legALow.index);
    const lineToday = legB.price + slope * (idx - legB.index);
    if (c.close >= lineToday) continue;
    const v = volInfo(candles, idx);
    return {
      position: 5, id: 'S5_abc_breakdown', name: 'ABC反彈跌破上升切線',
      stopLoss: c.high, volumeRatio: v.ratio, hasVolume: v.has,
      detail: `空頭 ABC 反彈後黑K收 ${c.close.toFixed(2)} 跌破上升切線 ${lineToday.toFixed(2)}（課程 6-12；量不要求、月線下向下）`,
    };
  }
  return null;
}

/** S6 跌破下跌軌道線（6-13）：兩下降低點連線＝軌道線下緣，大量中長黑收盤跌破＝空方轉強；明確要大量 */
function detectS6ChannelBreakdown(candles: CandleWithIndicators[], idx: number): ShortEntrySignal | null {
  const c = candles[idx];
  if (!isMedLongBlackBar(c)) return null;
  const v = volInfo(candles, idx);
  if (!v.has) return null;                                     // 課程 6-13 明確要大量（與 6-12 相反）
  const prev = candles[idx - 1];
  if (c.ma20 == null || prev?.ma20 == null || c.ma20 > prev.ma20) return null;  // MA20 向下硬濾網
  if (detectTrend(candles, idx) !== '空頭') return null;
  const pivots = findPivots(candles, idx, 8);
  const lows = pivots.filter(p => p.type === 'low').slice(0, 2);
  if (lows.length < 2) return null;
  const [lNew, lOld] = lows;
  if (lNew.price >= lOld.price) return null;                   // 下降通道：低點下移
  if (lNew.index - lOld.index < 6) return null;                // 緩步下跌（通道有跨度）
  const slope = (lNew.price - lOld.price) / (lNew.index - lOld.index);
  const lineToday = lNew.price + slope * (idx - lNew.index);
  if (c.close >= lineToday) return null;                       // 收盤跌破軌道線＝加速
  return {
    position: 6, id: 'S6_channel_breakdown', name: '跌破下跌軌道線',
    stopLoss: c.high, volumeRatio: v.ratio, hasVolume: v.has,
    detail: `大量中長黑收 ${c.close.toFixed(2)} 跌破下降軌道線 ${lineToday.toFixed(2)}，空方轉強（課程 6-13）${gapDownTag(candles, idx)}`,
  };
}

/** S7 飆股反彈紅K低點跌破（6-14）：最新講義以價位跌破為硬條件，量能只作強度標記。 */
function detectS7PlungeReboundBreak(candles: CandleWithIndicators[], idx: number): ShortEntrySignal | null {
  const c = candles[idx];
  if (!isMedLongBlackBar(c)) return null;
  const prev = candles[idx - 1];
  if (c.ma20 == null || prev?.ma20 == null || c.ma20 > prev.ma20) return null;  // 月線下彎（投影片）
  // 反彈紅K在「次日或 3 天內」：j ∈ [idx-3, idx-1]
  for (let j = idx - 1; j >= Math.max(1, idx - 3); j--) {
    const r = candles[j];
    if (!(r.open > 0 && r.close > r.open && (r.close - r.open) / r.open >= MIN_BODY_PCT)) continue;
    const reboundHasVolume = isBigVolRedBar(candles, j);
    if (c.close >= r.low) continue;                            // 收盤跌破反彈紅K最低點
    // 下跌飆股：反彈紅K 之前 20 根累跌 >20%（⚠️ 課程無數字，鏡像 L 軌）
    const base = candles[Math.max(0, j - 20)];
    if (!base || base.close <= 0) continue;
    if (r.close / base.close - 1 > PLUNGE_PCT) continue;
    const v = volInfo(candles, idx);
    return {
      position: 7, id: 'S7_plunge_rebound_break', name: '飆股反彈紅K低點跌破',
      stopLoss: c.high, volumeRatio: v.ratio, hasVolume: v.has,
      sourceVariant: 'latest_handout_volume_optional',
      detail: `下跌飆股反彈紅K（${r.date}；${reboundHasVolume ? '有大量' : '量未放大'}）低點 ${r.low.toFixed(2)} 被中長黑收 ${c.close.toFixed(2)} 跌破（${v.has ? '跌破K有大量' : '跌破K量未放大'}；課程 6-14 最新講義量能選配）${gapDownTag(candles, idx)}`,
    };
  }
  return null;
}

/** 做空 7 進場位置總偵測 — 回傳當日命中的所有空點（可能多個共振） */
export function detectShortEntries(
  candles: CandleWithIndicators[],
  idx: number,
): ShortEntrySignal[] {
  if (idx < 30 || !candles[idx] || !candles[idx - 1]) return [];
  const c = candles[idx];
  // 共同便宜前置：黑K 才可能是任何空點觸發（S4 內部也要求黑K）
  if (c.close >= c.open) return [];
  const out: ShortEntrySignal[] = [];
  const detectors = [
    detectS1ReboundShort, detectS2RangeBreakdown, detectS3KlineConsolBreakdown,
    detectS4TopPattern, detectS5AbcBreakdown, detectS6ChannelBreakdown,
    detectS7PlungeReboundBreak,
  ];
  for (const d of detectors) {
    const s = d(candles, idx);
    if (s) out.push(s);
  }
  return out;
}
