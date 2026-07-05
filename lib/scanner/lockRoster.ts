/**
 * 鎖股名單（獵兔計劃）持久化 roster — 課程 CH5-6（2026-07-05 批次D，大工程-3）
 *
 * 課程投影片 01/03（原文照抄）：
 *   - 鎖股名單汰弱留強 **10~15 檔**（15 已算很多、10 最好），持股 3~5 檔。
 *   - 每檔按「在等什麼」分 **8 類（獵兔計劃）**排操作順序：
 *     ①等打底 ②等突破 ③等拉回 ④等上漲 ⑤等K線橫盤突破 ⑥等ABC突破 ⑦等型態 ⑧等突破大量黑K
 *   - 排序心法：**盤到尾端/三角收斂擺最前面**（明後天沒地方跑、可能明天就做）。
 *   - 每日追蹤淘汰 8 種轉弱股票（連放都不要放）。
 *
 * 與既有 LockWatch（F/N 兩段生命週期）互補不取代：LockWatch 管「訊號→進場」，
 * roster 管「10~15 檔候選池的持久化＋每日汰弱＋在等什麼」。
 *
 * 純函式（本檔不做 IO）；儲存在 lib/storage/lockRosterStorage.ts、
 * 每日重算在 /api/cron/lock-roster。urgency 數值為操作順序 heuristic（⚠️ 課程只給
 * 「盤到尾端擺最前面」的排序心法，數字為自訂實作）。
 */

import type { CandleWithIndicators } from '@/types';
import { detectTrend, classifyConsolidationShape, findPivots } from '@/lib/analysis/trendAnalysis';
import { detectLetterNStructure } from '@/lib/analysis/v12LetterN';
import { getABCDisplayStructure } from '@/lib/analysis/abcBreakoutEntry';
import type { MarketId } from './types';

export type HuntCategory = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8;

export const HUNT_LABELS: Record<HuntCategory, string> = {
  1: '等打底', 2: '等突破', 3: '等拉回', 4: '等上漲',
  5: '等K線橫盤突破', 6: '等ABC突破', 7: '等型態', 8: '等突破大量黑K',
};

export interface HuntClassification {
  category: HuntCategory;
  label: string;
  /** 在等什麼（進場條件白話，抄課程表格） */
  waitingFor: string;
  /** 操作順序分 0-100（越高越前面；三角收斂尾端最高 — 課程排序心法） */
  urgency: number;
  urgencyDetail: string;
  /** 關鍵觸發價（頸線/區間高/切線/黑K高）— 盤中關鍵價監控（批次E）取用 */
  triggerLevel?: number;
}

export interface LockRosterEntry {
  symbol: string;
  name: string;
  market: MarketId;
  addedDate: string;
  source: 'auto-scan' | 'manual';
  category: HuntCategory;
  label: string;
  waitingFor: string;
  urgency: number;
  urgencyDetail: string;
  triggerLevel?: number;
  lastClose: number;
  lastReviewDate: string;
  /** 課程 8 種轉弱旗標（f6/f7/f8 = 硬汰弱；其餘資訊性） */
  weakFlags: string[];
  matchedLetters?: string[];
  history: { date: string; event: 'added' | 'reclassified' | 'weak-flag' | 'removed'; detail: string }[];
}

export interface LockRoster {
  market: MarketId;
  updatedAt: string;
  entries: LockRosterEntry[];
}

export interface RosterReview {
  market: MarketId;
  date: string;
  kept: number;
  added: { symbol: string; name: string; category: HuntCategory; detail: string }[];
  removed: { symbol: string; name: string; reasons: string[] }[];
  flagged: { symbol: string; name: string; flags: string[] }[];
}

/** 課程：10~15 檔，15 已算很多 */
export const ROSTER_MAX = 15;

const body = (c: CandleWithIndicators) => (c.open > 0 ? (c.close - c.open) / c.open : 0);

/** 四線多排（課程淘汰第(2)條：要選連季線都做好的） */
function fourLineAligned(c: CandleWithIndicators): boolean {
  return c.ma5 != null && c.ma10 != null && c.ma20 != null && c.ma60 != null
    && c.ma5 > c.ma10 && c.ma10 > c.ma20 && c.ma20 > c.ma60;
}

/**
 * 獵兔 8 分類：這檔現在「在等什麼」（課程 CH5-6 投影片 03 表格）
 * 檢查順序＝特定結構優先（8/5/6/7）→ 一般狀態（2/3/4/1）。
 */
export function classifyHuntCategory(
  candles: CandleWithIndicators[],
  idx: number,
): HuntClassification | null {
  if (idx < 30 || !candles[idx]) return null;
  const c = candles[idx];
  const trend = detectTrend(candles, idx);

  // ⑧ 等突破大量黑K：近3根內有爆大量黑K（量≥前日×2、實體≥2%），之後未跌破5均
  for (let k = 1; k <= 3; k++) {
    const b = candles[idx - k];
    const bp = candles[idx - k - 1];
    if (!b || !bp || bp.volume <= 0) continue;
    if (!(b.close < b.open && Math.abs(body(b)) >= 0.02 && b.volume >= bp.volume * 2)) continue;
    let heldMa5 = true;
    for (let j = idx - k + 1; j <= idx; j++) {
      const x = candles[j];
      if (x.ma5 != null && x.close < x.ma5) { heldMa5 = false; break; }
    }
    if (!heldMa5 || trend !== '多頭') continue;
    const dist = (b.high - c.close) / c.close;
    return {
      category: 8, label: HUNT_LABELS[8],
      waitingFor: `第三天大量紅K收盤突破黑K高點 ${b.high.toFixed(2)}（換手成功再走一波）`,
      urgency: Math.max(55, 85 - dist * 400),
      urgencyDetail: `爆大量黑K後未破5均，距黑K高 ${(dist * 100).toFixed(1)}%`,
      triggerLevel: b.high,
    };
  }

  // ⑤ 等K線橫盤突破：多頭中近 3~10 根收盤卡在一根中長K（實體≥3%）高低之間
  if (trend === '多頭') {
    for (let gap = 4; gap <= 11; gap++) {
      const a = candles[idx - gap];
      if (!a || a.open <= 0 || Math.abs(body(a)) < 0.03) continue;
      let ok = true;
      for (let j = idx - gap + 1; j <= idx; j++) {
        const x = candles[j];
        if (x.close > a.high || x.close < a.low) { ok = false; break; }
      }
      if (!ok) continue;
      const dist = (a.high - c.close) / c.close;
      return {
        category: 5, label: HUNT_LABELS[5],
        waitingFor: `大量中長紅K收盤突破橫盤最高 ${a.high.toFixed(2)}（以盤代跌=多方強）`,
        urgency: Math.max(50, 80 - dist * 400),
        urgencyDetail: `橫盤 ${gap - 1} 根，距區間高 ${(dist * 100).toFixed(1)}%`,
        triggerLevel: a.high,
      };
    }
  }

  // ⑥ 等ABC突破：ABC 修正結構存在未突破 + 月線向上（課程：月線向上+突破下降切線就買）
  const abc = getABCDisplayStructure(candles, idx);
  const prevMa20 = candles[idx - 1]?.ma20;
  if (abc && !abc.isFullBreakout && !abc.brokeTrendline
    && c.ma20 != null && prevMa20 != null && c.ma20 >= prevMa20) {
    const dist = (abc.trendlineValue - c.close) / c.close;
    return {
      category: 6, label: HUNT_LABELS[6],
      waitingFor: `大量紅K收盤突破下降切線 ${abc.trendlineValue.toFixed(2)}（月線向上前提已成立）`,
      urgency: Math.max(45, 75 - Math.abs(dist) * 300),
      urgencyDetail: `ABC 修正中，距切線 ${(dist * 100).toFixed(1)}%`,
      triggerLevel: abc.trendlineValue,
    };
  }

  // ⑦ 等型態：底部型態結構成立、未過真突破
  const n = detectLetterNStructure(candles, idx);
  if (n.patternType && n.necklinePrice != null && c.close <= n.necklinePrice * 1.0) {
    const dist = (n.necklinePrice - c.close) / c.close;
    return {
      category: 7, label: HUNT_LABELS[7],
      waitingFor: `大量中長紅K收盤突破頸線 ${n.necklinePrice.toFixed(2)}（${n.patternType} 型態確認）`,
      urgency: Math.max(40, 70 - dist * 300),
      urgencyDetail: `${n.patternType} 結構成立，距頸線 ${(dist * 100).toFixed(1)}%`,
      triggerLevel: n.necklinePrice,
    };
  }

  // ② 等突破：盤整中（已走過升段 = 價在季線上）；三角收斂尾端擺最前面（課程排序心法）
  if (trend === '盤整' && c.ma60 != null && c.close > c.ma60) {
    const shape = classifyConsolidationShape(candles, idx);
    const pivots = findPivots(candles, idx, 6);
    const highs = pivots.filter(p => p.type === 'high').slice(0, 2);
    const upper = highs.length ? Math.max(...highs.map(h => h.price)) : c.close * 1.03;
    const dist = (upper - c.close) / c.close;
    const isTriangle = shape?.shape === '三角收斂';
    return {
      category: 2, label: HUNT_LABELS[2],
      waitingFor: `大量紅K收盤突破上頸線 ${upper.toFixed(2)}${shape ? `（${shape.shape}）` : ''}`,
      urgency: isTriangle ? 92 : Math.max(50, 78 - dist * 300),
      urgencyDetail: isTriangle
        ? '三角收斂盤到尾端 — 明後天沒地方跑，擺最前面（課程原話）'
        : `盤整等表態，距上頸線 ${(dist * 100).toFixed(1)}%`,
      triggerLevel: upper,
    };
  }

  if (trend === '多頭') {
    // ④ 等上漲：回檔中（收盤在5均下、未破前低）→ 進場比等拉回快（課程原話）
    if (c.ma5 != null && c.close < c.ma5) {
      const prevHigh = candles[idx - 1]?.high ?? c.high;
      return {
        category: 4, label: HUNT_LABELS[4],
        waitingFor: `站回5均＋大量紅K過前一日最高 ${prevHigh.toFixed(2)}（回後買上漲）`,
        urgency: 65,
        urgencyDetail: '已在回檔中，符合條件就做（比等拉回類快）',
        triggerLevel: prevHigh,
      };
    }
    // ③ 等拉回：連續上漲高檔（近5根漲>8% 或 MA20乖離>10%）→ 不追高
    const base5 = candles[idx - 5];
    const gain5 = base5 && base5.close > 0 ? c.close / base5.close - 1 : 0;
    const dev20 = c.ma20 != null && c.ma20 > 0 ? (c.close - c.ma20) / c.ma20 : 0;
    if (gain5 > 0.08 || dev20 > 0.10) {
      return {
        category: 3, label: HUNT_LABELS[3],
        waitingFor: '等拉回再上漲（不追高；拉回變弱/長黑爆量就不做）',
        urgency: 35,
        urgencyDetail: `連漲高檔（5日 ${(gain5 * 100).toFixed(1)}%／乖離 ${(dev20 * 100).toFixed(1)}%），等拉回`,
      };
    }
    // 一般多頭行進間 → 歸 ④（等回檔後的上漲條件）
    return {
      category: 4, label: HUNT_LABELS[4],
      waitingFor: '多頭行進間 — 等回檔後站回5均＋大量紅K過前高',
      urgency: 45,
      urgencyDetail: '多頭中繼，等下一個回檔買點',
    };
  }

  // ① 等打底：空頭/盤整低檔（價在季線下）
  if (c.ma60 == null || c.close < c.ma60) {
    return {
      category: 1, label: HUNT_LABELS[1],
      waitingFor: '等底部完成、多頭確認（頭頭高＋底底高）再買',
      urgency: 20,
      urgencyDetail: '低檔打底中（課程：底部未完成不急著進）',
    };
  }
  return null;
}

/**
 * 課程 CH5-6 投影片 01「每日追蹤淘汰 8 種轉弱股票」。
 * f6/f7/f8 = 硬汰弱事件（發生即淘汰）；f1~f5 = 資訊性旗標（收錄品質提醒）。
 */
export function evaluateWeakFlags(
  candles: CandleWithIndicators[],
  idx: number,
  category: HuntCategory,
): { flags: string[]; hardRemove: string[] } {
  const flags: string[] = [];
  const hardRemove: string[] = [];
  const c = candles[idx];
  const prev = candles[idx - 1];
  if (!c || !prev) return { flags, hardRemove };
  const trend = detectTrend(candles, idx);

  // (1) 底部未完成（等打底/等型態類是刻意鎖底部 → 不標）
  if (trend !== '多頭' && category !== 1 && category !== 7 && category !== 2) {
    flags.push('(1)底部未完成/非多頭');
  }
  // (2) 未四線多排（打底/型態類天生未多排 → 不標）
  if (!fourLineAligned(c) && category !== 1 && category !== 7) {
    flags.push('(2)未四線多排（季線未做好）');
  }
  // (3) 上漲K線黑多紅少：近10根黑K ≥7
  const blacks = candles.slice(Math.max(0, idx - 9), idx + 1).filter(x => x.close < x.open).length;
  if (blacks >= 7) flags.push('(3)黑多紅少（方向不明）');
  // (4) 接近重壓：近120根最高價在上方 3% 內
  let hi120 = -Infinity;
  for (let j = Math.max(0, idx - 120); j < idx; j++) if (candles[j].high > hi120) hi120 = candles[j].high;
  if (isFinite(hi120) && c.close < hi120 && (hi120 - c.close) / c.close <= 0.03) {
    flags.push('(4)接近重壓（前高 3% 內）');
  }
  // (6) 爆量長黑吞噬 或 長上影線回檔 【硬汰弱】
  const isBigVol = prev.volume > 0 && c.volume >= prev.volume * 2;
  const engulfRed = prev.close > prev.open && c.close < c.open && c.open >= prev.close && c.close <= prev.open;
  const upperShadow = c.high - Math.max(c.open, c.close);
  const longUpper = upperShadow > Math.abs(c.close - c.open) && upperShadow / c.close >= 0.02;
  if (isBigVol && (engulfRed || longUpper)) {
    const f = `(6)爆量${engulfRed ? '長黑吞噬' : '長上影回檔'}（短期不易過高）`;
    flags.push(f); hardRemove.push(f);
  }
  // (7) 回檔大量連 3 黑 / 4 黑 【硬汰弱】
  const last3 = [candles[idx - 2], candles[idx - 1], c];
  if (last3.every(x => x && x.close < x.open)) {
    const heavy = last3.filter(x => x.avgVol5 != null && x.avgVol5 > 0 && x.volume > x.avgVol5!).length;
    if (heavy >= 2) { const f = '(7)回檔大量連3黑'; flags.push(f); hardRemove.push(f); }
  }
  // (8) 回檔跌破月線或前低 【硬汰弱】（等打底類本來就在月線下 → 只看破前低）
  const pivots = findPivots(candles, idx, 6);
  const lastLow = pivots.find(p => p.type === 'low');
  const brokeMa20 = category !== 1 && category !== 7 && c.ma20 != null && c.close < c.ma20;
  const brokeLow = lastLow != null && c.close < lastLow.price;
  if (brokeMa20 || brokeLow) {
    const f = `(8)跌破${brokeLow ? '前低' : '月線'}（趨勢改變）`;
    flags.push(f); hardRemove.push(f);
  }
  return { flags, hardRemove };
}

export interface RosterCandidate {
  symbol: string;
  name: string;
  matchedLetters?: string[];
}

/**
 * 每日 roster 演進（純函式）：
 *   1. 舊名單逐檔重分類 + 汰弱（hardRemove → 淘汰；manual 來源只旗標不刪 — 尊重手動鎖股）
 *   2. 新候選（當日掃描結果）補進空位，按 urgency 高者優先，上限 ROSTER_MAX
 *   3. 依 urgency 排序（課程：盤到尾端擺最前面）
 */
export function evolveRoster(args: {
  market: MarketId;
  date: string;
  prev: LockRoster | null;
  candidates: RosterCandidate[];
  candlesOf: (symbol: string) => CandleWithIndicators[] | null;
}): { roster: LockRoster; review: RosterReview } {
  const { market, date, prev, candidates, candlesOf } = args;
  const review: RosterReview = { market, date, kept: 0, added: [], removed: [], flagged: [] };
  const entries: LockRosterEntry[] = [];
  const seen = new Set<string>();

  // ── 1. 舊名單演進 ──
  for (const e of prev?.entries ?? []) {
    if (seen.has(e.symbol)) continue;
    seen.add(e.symbol);
    const cs = candlesOf(e.symbol);
    const idx = cs ? cs.length - 1 : -1;
    if (!cs || idx < 30) { entries.push({ ...e, lastReviewDate: date }); review.kept++; continue; }

    const cls = classifyHuntCategory(cs, idx);
    if (!cls) {
      review.removed.push({ symbol: e.symbol, name: e.name, reasons: ['無法歸類（結構消失）'] });
      continue;
    }
    const weak = evaluateWeakFlags(cs, idx, cls.category);
    if (weak.hardRemove.length && e.source === 'auto-scan') {
      review.removed.push({ symbol: e.symbol, name: e.name, reasons: weak.hardRemove });
      continue;
    }
    const updated: LockRosterEntry = {
      ...e,
      category: cls.category, label: cls.label, waitingFor: cls.waitingFor,
      urgency: cls.urgency, urgencyDetail: cls.urgencyDetail, triggerLevel: cls.triggerLevel,
      lastClose: cs[idx].close, lastReviewDate: date, weakFlags: weak.flags,
      history: e.category !== cls.category
        ? [...e.history, { date, event: 'reclassified' as const, detail: `${HUNT_LABELS[e.category]} → ${cls.label}` }]
        : e.history,
    };
    if (weak.flags.length) review.flagged.push({ symbol: e.symbol, name: e.name, flags: weak.flags });
    if (weak.hardRemove.length && e.source === 'manual') {
      updated.history = [...updated.history, { date, event: 'weak-flag', detail: `⚠️ 課程汰弱條件命中（手動鎖股保留）：${weak.hardRemove.join('、')}` }];
    }
    entries.push(updated);
    review.kept++;
  }

  // ── 2. 新候選補位 ──
  const scored: { cand: RosterCandidate; cls: HuntClassification; close: number }[] = [];
  for (const cand of candidates) {
    if (seen.has(cand.symbol)) continue;
    const cs = candlesOf(cand.symbol);
    const idx = cs ? cs.length - 1 : -1;
    if (!cs || idx < 30) continue;
    const cls = classifyHuntCategory(cs, idx);
    if (!cls) continue;
    const weak = evaluateWeakFlags(cs, idx, cls.category);
    if (weak.hardRemove.length || weak.flags.length >= 3) continue;   // 課程：連放都不要放
    scored.push({ cand, cls, close: cs[idx].close });
  }
  scored.sort((a, b) => b.cls.urgency - a.cls.urgency);
  for (const s of scored) {
    if (entries.length >= ROSTER_MAX) break;
    seen.add(s.cand.symbol);
    entries.push({
      symbol: s.cand.symbol, name: s.cand.name, market,
      addedDate: date, source: 'auto-scan',
      category: s.cls.category, label: s.cls.label, waitingFor: s.cls.waitingFor,
      urgency: s.cls.urgency, urgencyDetail: s.cls.urgencyDetail, triggerLevel: s.cls.triggerLevel,
      lastClose: s.close, lastReviewDate: date, weakFlags: [],
      matchedLetters: s.cand.matchedLetters,
      history: [{ date, event: 'added', detail: `掃描入選（${s.cls.label}｜${s.cls.urgencyDetail}）` }],
    });
    review.added.push({ symbol: s.cand.symbol, name: s.cand.name, category: s.cls.category, detail: s.cls.urgencyDetail });
  }

  // ── 3. 依操作順序排序 ──
  entries.sort((a, b) => b.urgency - a.urgency);

  return { roster: { market, updatedAt: new Date().toISOString(), entries }, review };
}
