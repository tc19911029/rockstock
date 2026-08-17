/**
 * multiTimeframeFilter.ts — 長線保護短線：多時間框架前置過濾器
 *
 * 來源：
 *   《抓住線圖》戰法1「長線保護短線」
 *   《做對5個實戰步驟》月線→週線→日線 SOP
 *   《活用技術分析寶典》「用週線控管依日線進場的風險」
 *   朱家泓網路實例（伍豐/宣德）確認 MTF 為 checklist 非評分公式
 *
 * 2026-04-20 重寫為 checklist，對齊朱家泓原意
 *
 * 週線保護 4 項（方向／位置／壓力，而不是要求本週再次出現攻擊 K）：
 *   #1 週線趨勢多頭（必要）
 *   #2 週 MA10/MA20 方向向上
 *   #3 週收盤站上 MA20
 *   #4 未接近週線前高；若接近，當週必須帶策略量能確認
 *
 * 月線 1 項：
 *   #1 月線趨勢不是空頭（寬鬆）
 */

import type { CandleWithIndicators } from '@/types';
import type { StrategyThresholds } from '@/lib/strategy/StrategyConfig';
import { aggregateCandles } from '@/lib/datasource/aggregateCandles';
import { computeIndicators } from '@/lib/indicators';
import { detectTrend, findPivots, TrendState } from '@/lib/analysis/trendAnalysis';
import { isTradingDay } from '@/lib/utils/tradingDay';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface TimeframeCheckResult {
  timeframe: 'weekly' | 'monthly';
  trend: TrendState;
  pass: boolean;
  score: number;
  detail: string;
}

/**
 * 週線攻擊型態 6 項觀察資料（不作 MTF gate）
 * ① 趨勢多頭 ② 均線多排+向上 ③ 股價位置>MA10/MA20 ④ 攻擊量 ⑤ 紅K實體+高收盤+上影 ⑥ MACD+KD
 */
export interface WeeklyChecks {
  trend: boolean;       // ① 趨勢多頭（頭頭高底底高）
  ma: boolean;          // ② MA5/10/20 三線多排 + MA10/MA20 向上（1根比較）
  position: boolean;    // ③ 收盤 > MA10 AND 收盤 > MA20
  volume: boolean;      // ④ 週量 ≥ 前週 × 1.3
  kbar: boolean;        // ⑤ 紅K實體 ≥ 2% + 高收盤 + 上影 ≤ 實體
  indicator: boolean;   // ⑥ (MACD 綠柱縮小 OR 紅柱延長) AND KD 金叉向上
}

/** 真正參與「長線保護短線」gate 的 4 項。 */
export interface WeeklyProtectionChecks {
  trend: boolean;
  maDirection: boolean;
  position: boolean;
  resistance: boolean;
}

export interface MultiTimeframeResult {
  weekly: TimeframeCheckResult;
  monthly: TimeframeCheckResult;
  /** 週線攻擊型態觀察資料；不作 MTF gate。 */
  weeklyChecks: WeeklyChecks;
  weeklyProtectionChecks: WeeklyProtectionChecks;
  totalScore: number;              // 週線保護 0-4
  pass: boolean;
  /** 向下相容舊回測腳本。 */
  weeklyPass: boolean;
  monthlyPass: boolean;
  weeklyNearResistance: boolean;   // 保留給戒律4使用
  weeklyResistanceDetail?: string;
}

// ── Weekly checks ─────────────────────────────────────────────────────────────

type MtfMarket = 'TW' | 'CN';

function addCalendarDays(dateStr: string, days: number): string {
  const date = new Date(`${dateStr}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function nextTradingDate(dateStr: string, market: MtfMarket): string {
  let next = addCalendarDays(dateStr, 1);
  for (let guard = 0; guard < 20; guard++) {
    if (isTradingDay(next, market)) return next;
    next = addCalendarDays(next, 1);
  }
  return next;
}

function taipeiClock(now: Date): { date: string; hm: number } {
  const shifted = new Date(now.getTime() + 8 * 3600_000);
  return {
    date: shifted.toISOString().slice(0, 10),
    hm: shifted.getUTCHours() * 100 + shifted.getUTCMinutes(),
  };
}

/**
 * 最後一根日 K 是否真的結束了所屬週／月。
 * 用下一個交易日（含市場假日表）判斷週月邊界，再用收盤時間擋掉今日盤中半根 K。
 */
export function isHigherTimeframePeriodClosed(
  lastDailyDate: string | undefined,
  period: 'weekly' | 'monthly',
  market: MtfMarket = 'TW',
  now = new Date(),
): boolean {
  if (!lastDailyDate) return false;
  const clock = taipeiClock(now);
  if (lastDailyDate > clock.date) return false;
  const closeHm = market === 'CN' ? 1510 : 1345;
  if (lastDailyDate === clock.date && clock.hm <= closeHm) return false;

  const next = nextTradingDate(lastDailyDate, market);
  if (period === 'monthly') return next.slice(0, 7) !== lastDailyDate.slice(0, 7);

  const currentMonday = (() => {
    const date = new Date(`${lastDailyDate}T12:00:00Z`);
    const dow = date.getUTCDay();
    date.setUTCDate(date.getUTCDate() - (dow === 0 ? 6 : dow - 1));
    return date.toISOString().slice(0, 10);
  })();
  const nextMonday = (() => {
    const date = new Date(`${next}T12:00:00Z`);
    const dow = date.getUTCDay();
    date.setUTCDate(date.getUTCDate() - (dow === 0 ? 6 : dow - 1));
    return date.toISOString().slice(0, 10);
  })();
  return nextMonday !== currentMonday;
}

/**
 * 同時計算兩組資料：4 項保護條件參與 MTF gate；6 項攻擊型態只供觀察。
 * ① 趨勢多頭（頭頭高底底高）
 * ② MA5/10/20 三線多排 + MA10/20 向上（1 根比較）
 * ③ 收盤 > MA10 AND MA20
 * ④ 週量 ≥ 前週 × 1.3
 * ⑤ 紅K實體 ≥ 2% + 高收盤 + 上影 ≤ 實體
 * ⑥ (MACD 綠縮 OR 紅延) AND KD 金叉向上
 *
 */
function checkWeekly(
  weeklyCandles: CandleWithIndicators[],
  thresholds: StrategyThresholds,
  /** 最後一根日 K 的日期；用來判斷最新週是否已收盤完整 */
  lastDailyDate?: string,
  market: MtfMarket = 'TW',
): {
  score: number;
  trend: TrendState;
  nearResistance: boolean;
  resistanceDetail?: string;
  detail: string;
  checks: WeeklyChecks;
  protectionChecks: WeeklyProtectionChecks;
} {
  // 判斷最新週是否已收盤：只有「週五且該交易日已結束」才使用本週。
  // 盤中半根 K 一律退回上一個完整週，避免週五上午偷看未完成週線。
  const lastDaily = lastDailyDate ?? weeklyCandles[weeklyCandles.length - 1]?.date;
  const isWeekClosed = isHigherTimeframePeriodClosed(lastDaily, 'weekly', market);
  const evalIdx = isWeekClosed ? weeklyCandles.length - 1 : weeklyCandles.length - 2;
  if (evalIdx < 20) {
    return {
      score: 4,
      trend: '盤整',
      nearResistance: false,
      detail: '週線數據不足，跳過檢查',
      checks: { trend: true, ma: true, position: true, volume: true, kbar: true, indicator: true },
      protectionChecks: { trend: true, maDirection: true, position: true, resistance: true },
    };
  }

  const c = weeklyCandles[evalIdx];
  const prev = weeklyCandles[evalIdx - 1];

  // ── ① 趨勢多頭（頭頭高底底高，用週線）──
  const trend = detectTrend(weeklyCandles, evalIdx);
  const trendPass = trend === '多頭';

  // ── ② MA5/10/20 三線多排 + MA10/MA20 向上（1根比較）──
  let maPass = false;
  const { ma5, ma10, ma20 } = c;
  const prevMa10 = prev?.ma10;
  const prevMa20 = prev?.ma20;
  if (ma5 != null && ma10 != null && ma20 != null) {
    const threeLineBullish = ma5 > ma10 && ma10 > ma20;
    const ma10Rising = prevMa10 != null && ma10 > prevMa10;
    const ma20Rising = prevMa20 != null && ma20 > prevMa20;
    maPass = threeLineBullish && ma10Rising && ma20Rising;
  } else {
    maPass = true;
  }

  // ── ③ 股價位置：close > MA10 AND close > MA20 ──
  const positionPass = (ma10 != null && ma20 != null)
    ? (c.close > ma10 && c.close > ma20)
    : true;

  // ── ④ 攻擊量：週量 ≥ 前週 × 1.3 ──
  const volumePass = prev != null && prev.volume > 0
    ? c.volume >= prev.volume * thresholds.volumeRatioMin
    : true;

  // ── ⑤ 紅K實體 ≥ 2% + 高收盤 + 上影 ≤ 實體 ──
  const bodyPct = c.open > 0 ? (c.close - c.open) / c.open : 0;
  const bodyAbs = Math.abs(c.close - c.open);
  const isRedK = c.close > c.open;
  const isBodyEnough = bodyPct >= 0.02;
  const dayRange = c.high - c.low;
  const closePos = dayRange > 0 ? (c.close - c.low) / dayRange : 0;
  const isHighClose = closePos >= 0.5;
  const upperShadow = c.high - Math.max(c.open, c.close);
  const noLongUpperShadow = upperShadow <= bodyAbs;
  const kbarPass = isRedK && isBodyEnough && isHighClose && noLongUpperShadow;

  // ── ⑥ (MACD 綠柱縮小 OR 紅柱延長) AND KD 金叉向上 ──
  const oscNow = c.macdOSC;
  const oscPrev = prev?.macdOSC;
  let macdOk = true;
  if (oscNow != null && oscPrev != null) {
    const redExtending = oscNow > 0 && oscNow > oscPrev;
    const greenShrinking = oscNow < 0 && oscNow > oscPrev;
    macdOk = redExtending || greenShrinking;
  }
  const kdK = c.kdK;
  const kdD = c.kdD;
  const prevKdK = prev?.kdK;
  const prevKdD = prev?.kdD;
  let kdOk = true;
  if (kdK != null && kdD != null && prevKdK != null && prevKdD != null) {
    kdOk = prevKdK <= prevKdD && kdK > kdD;
  }
  const indicatorPass = macdOk && kdOk;

  // ── 週線壓力區（保留給戒律 4，不算 checklist 項）──
  let nearResistance = false;
  let resistanceDetail: string | undefined;
  const pivots = findPivots(weeklyCandles, evalIdx, 6);
  const swingHighs = pivots
    .filter(p => p.type === 'high')
    .filter(p => p.index < evalIdx - 1);
  for (const sh of swingHighs) {
    if (sh.price <= 0) continue;
    const distPct = (sh.price - c.close) / sh.price;
    if (distPct > 0 && distPct < 0.03) {
      nearResistance = true;
      resistanceDetail = `週收盤 ${c.close.toFixed(2)} 接近前高壓力 ${sh.price.toFixed(2)}（差距 ${(distPct * 100).toFixed(1)}%）`;
      break;
    }
  }

  const checks: WeeklyChecks = {
    trend: trendPass,
    ma: maPass,
    position: positionPass,
    volume: volumePass,
    kbar: kbarPass,
    indicator: indicatorPass,
  };
  const maDirectionPass = ma10 != null && ma20 != null && prevMa10 != null && prevMa20 != null
    ? ma10 > prevMa10 && ma20 > prevMa20
    : true;
  const protectionPositionPass = ma20 != null ? c.close > ma20 : true;
  // 教材語意是「接近壓力要帶量」，不是任何週都必須爆量。
  const resistancePass = !nearResistance || volumePass;
  const protectionChecks: WeeklyProtectionChecks = {
    trend: trendPass,
    maDirection: maDirectionPass,
    position: protectionPositionPass,
    resistance: resistancePass,
  };
  const score = Object.values(protectionChecks).filter(Boolean).length;

  const items: string[] = [];
  items.push(`①週趨勢${trend}${trendPass ? '✅' : '❌'}`);
  items.push(`②週均線方向${maDirectionPass ? '✅MA10/20向上' : '❌MA10/20未同步向上'}`);
  items.push(`③週線位置${protectionPositionPass ? '✅站上MA20' : '❌跌破MA20'}`);
  items.push(`④週線壓力${resistancePass ? (nearResistance ? '✅近壓帶量' : '✅無近壓') : '❌近前高但未帶量'}`);

  return {
    score,
    trend,
    nearResistance,
    resistanceDetail,
    detail: items.join('，'),
    checks,
    protectionChecks,
  };
}

// ── Monthly checks ────────────────────────────────────────────────────────────

/**
 * 月線檢查 #4: 趨勢不是空頭
 * 回傳 0-1 分
 */
function checkMonthly(
  monthlyCandles: CandleWithIndicators[],
  lastDailyDate?: string,
  market: MtfMarket = 'TW',
): {
  score: number;
  trend: TrendState;
  detail: string;
} {
  // 只有曆月最後一個工作日且交易日已結束才使用當月；不可把 25 日後仍
  // 有數個交易日的半成品月 K 當成完整月線。
  const lastDaily = lastDailyDate ?? monthlyCandles[monthlyCandles.length - 1]?.date;
  const isMonthClosed = isHigherTimeframePeriodClosed(lastDaily, 'monthly', market);
  const evalIdx = isMonthClosed ? monthlyCandles.length - 1 : monthlyCandles.length - 2;
  if (evalIdx < 5) {
    return {
      score: 1, // 數據不足，不懲罰
      trend: '盤整',
      detail: '月線數據不足，跳過檢查',
    };
  }

  const trend = detectTrend(monthlyCandles, evalIdx);
  const score = trend !== '空頭' ? 1 : 0;

  const c = monthlyCandles[evalIdx];
  const ma5 = c.ma5;
  const parts: string[] = [];

  if (score) {
    parts.push(`月線${trend}`);
    if (ma5 != null && c.close > ma5) parts.push(`站上月MA5(${ma5.toFixed(0)})`);
  } else {
    parts.push('月線空頭');
  }

  return { score, trend, detail: parts.join('，') };
}

// ── 聚合快取（同一組陣列 reference 才可共用）───────────────────────────────
// 不可用「最後日期＋根數」當 key：全市場股票通常兩者完全相同，會讓第二檔
// 開始沿用第一檔的週線/月線。WeakMap 以輸入陣列 identity 隔離股票，也不會
// 因長時間掃描持有已不用的 K 線陣列。
type AggregationSlots = Partial<Record<'1wk' | '1mo', CandleWithIndicators[]>>;
let _aggregationCache = new WeakMap<CandleWithIndicators[], AggregationSlots>();

function getCachedAggregation(
  dailyCandles: CandleWithIndicators[],
  interval: '1wk' | '1mo',
): CandleWithIndicators[] {
  const slots = _aggregationCache.get(dailyCandles);
  const cached = slots?.[interval];
  if (cached) return cached;

  const result = computeIndicators(aggregateCandles(dailyCandles, interval));
  _aggregationCache.set(dailyCandles, { ...slots, [interval]: result });
  return result;
}

/** 手動清除快取（掃描結束後呼叫） */
export function clearAggregationCache(): void {
  _aggregationCache = new WeakMap<CandleWithIndicators[], AggregationSlots>();
}

/** 將 4 項週線保護條件套用使用者門檻；趨勢方向永遠是必要條件。 */
export function evaluateWeeklyProtectionGate(
  checks: WeeklyProtectionChecks,
  configuredMinScore: number,
): { score: number; minScore: number; pass: boolean } {
  const score = Object.values(checks).filter(Boolean).length;
  const minScore = Math.max(0, Math.min(4, configuredMinScore));
  return { score, minScore, pass: checks.trend && score >= minScore };
}

/**
 * 判斷今日收盤是否接近週線前高壓力（戒律 4 專用）
 * 聚合日 K → 週 K → 找 pivot high → 比較今日 close 距最近的前高
 * @param proximityPct 接近度（預設 0.03 = 3% 以內算接近）
 *                     注：朱家泓書+網路均無「接近%」具體值（只寫「接近壓力必帶量」），3% 為實作自選
 */
export function isNearWeeklyResistance(
  dailyCandles: CandleWithIndicators[],
  proximityPct = 0.03,
): { near: boolean; detail?: string } {
  if (dailyCandles.length < 60) return { near: false };
  const todayClose = dailyCandles[dailyCandles.length - 1].close;

  const weeklyCandles = getCachedAggregation(dailyCandles, '1wk');
  if (weeklyCandles.length < 4) return { near: false };

  // 用最後一根之前的週 K 找 pivot（避免今日所在那根週 K 自己當壓力）
  const evalIdx = weeklyCandles.length - 2;
  const pivots = findPivots(weeklyCandles, evalIdx, 6);
  // 只檢查「最近一個」週線頭（書本：週線最近的頭=壓力）
  const latestHigh = pivots.find(p => p.type === 'high' && p.index < evalIdx - 1);
  if (!latestHigh || latestHigh.price <= 0) return { near: false };

  const distPct = (latestHigh.price - todayClose) / latestHigh.price;
  if (distPct > 0 && distPct < proximityPct) {
    return {
      near: true,
      detail: `週線最近的頭 ${latestHigh.price.toFixed(2)}，今日收盤 ${todayClose.toFixed(2)}（差距 ${(distPct*100).toFixed(1)}%）`,
    };
  }
  return { near: false };
}

// ── Main evaluator ────────────────────────────────────────────────────────────

/**
 * 多時間框架前置過濾器
 *
 * @param dailyCandles 日K資料（含指標），至少需要 60 根以上
 * @param thresholds   策略設定（含 MTF 開關和門檻）
 * @returns MultiTimeframeResult
 */
export function evaluateMultiTimeframe(
  dailyCandles: CandleWithIndicators[],
  thresholds: StrategyThresholds,
  market: MtfMarket = 'TW',
): MultiTimeframeResult {
  // P2B: 使用快取的聚合結果（同一掃描內相同輸入直接返回）
  const weeklyCandles = getCachedAggregation(dailyCandles, '1wk');
  const monthlyCandles = getCachedAggregation(dailyCandles, '1mo');

  const lastDailyDate = dailyCandles[dailyCandles.length - 1]?.date;
  const weekly = checkWeekly(weeklyCandles, thresholds, lastDailyDate, market);
  const monthly = checkMonthly(monthlyCandles, lastDailyDate, market);

  const mtfWeeklyStrict = thresholds.mtfWeeklyStrict ?? true;
  const mtfMonthlyStrict = thresholds.mtfMonthlyStrict ?? false;
  const weeklyGate = evaluateWeeklyProtectionGate(
    weekly.protectionChecks,
    thresholds.mtfMinScore ?? 3,
  );
  const weeklyPass = weeklyGate.pass;
  const monthlyPass = monthly.score >= 1;
  const pass = (!mtfWeeklyStrict || weeklyPass) && (!mtfMonthlyStrict || monthlyPass);
  const totalScore = weeklyGate.score;

  return {
    weekly: {
      timeframe: 'weekly',
      trend: weekly.trend,
      pass: weeklyPass,
      score: weekly.score,
      detail: weekly.detail,
    },
    monthly: {
      timeframe: 'monthly',
      trend: monthly.trend,
      pass: monthly.score >= 1,
      score: monthly.score,
      detail: monthly.detail,
    },
    weeklyChecks: weekly.checks,
    weeklyProtectionChecks: weekly.protectionChecks,
    totalScore,
    pass,
    weeklyPass,
    monthlyPass,
    weeklyNearResistance: weekly.nearResistance,
    weeklyResistanceDetail: weekly.resistanceDetail,
  };
}
