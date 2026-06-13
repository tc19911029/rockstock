/**
 * 陸股 AI 選股 Agent — 漲停池統計 + 市場寬度組裝層（純函式，零 IO）
 *
 * 設計原則：所有計算都是 (輸入, 昨日檔) → 輸出 的純函式，方便回測重放
 * 與單元測試（fixture 直餵，不碰網路 / 不碰儲存層）。IO 由 cron route
 * 負責：讀昨檔 → 呼叫本檔組裝 → 交 storage.ts 落地。
 *
 * ST 處理鐵則（與 types.ts LimitUpPoolStats 註解對齊）：
 *   limitUpCount / heightDist / maxHeight / board2PlusCount / oneWordCount /
 *   cm20LimitUpCount / brokenCount / 晉級率 全部排除 isST（ST 5% 波動帶
 *   封板太容易，混入會稀釋情緒訊號），stLimitUpCount 另計。
 *   limitDownCount 含 ST（跌停本身就是恐慌指標，ST 殺跌也算）。
 *
 * 晉級率陷阱：d1to2 / d2to3 嚴格比對「今日 consecBoards === 昨日+1」，
 * 不能只看「今日還在漲停池」— 中斷後重新首板（昨 1 板 → 今又顯示 1 板）
 * 不算晉級。d3plus（昨 ≥3 板）放寬為「今日仍在漲停池」即算續板：高位板
 * 的 EM consecBoards 偶有「N天M板」斷板重計 quirk，嚴格 +1 比對會漏算。
 */

import type {
  BrokenEntry,
  CnAgentsDataSource,
  LimitDownEntry,
  LimitUpEntry,
  LimitUpPoolDay,
  LimitUpPoolStats,
  MarketBreadthDay,
  MarketOverview,
  PromotionStat,
} from './types';
import { CN_AGENTS_SCHEMA_VERSION } from './types';

// ── 漲停池統計 ────────────────────────────────────────────────────────────────

export function computePoolStats(args: {
  limitUp: LimitUpEntry[];
  broken: BrokenEntry[];
  limitDown: LimitDownEntry[];
  yesterdayPool: LimitUpPoolDay | null;
  yesterdayLimitUpAvgPct: number | null;
  yesterdayBrokenAvgPct: number | null;
}): LimitUpPoolStats {
  const { limitUp, broken, limitDown, yesterdayPool } = args;

  const nonSt = limitUp.filter((e) => !e.isST);
  const nonStBroken = broken.filter((e) => !e.isST);

  const limitUpCount = nonSt.length;
  const brokenCount = nonStBroken.length;
  const denom = limitUpCount + brokenCount;

  // 連板梯隊（非 ST）；consecBoards 防呆 clamp 到 ≥1（漲停池內首板=1）
  const heightDist: LimitUpPoolStats['heightDist'] = { '1': 0, '2': 0, '3': 0, '4+': 0 };
  let maxHeight = 0;
  for (const e of nonSt) {
    const h = Math.max(1, e.consecBoards);
    if (h >= 4) heightDist['4+'] += 1;
    else heightDist[String(h) as '1' | '2' | '3'] += 1;
    if (h > maxHeight) maxHeight = h;
  }
  const maxHeightSymbols =
    maxHeight > 0 ? nonSt.filter((e) => Math.max(1, e.consecBoards) === maxHeight).map((e) => e.symbol) : [];

  return {
    limitUpCount,
    limitDownCount: limitDown.length, // 含 ST，見檔頭
    brokenCount,
    sealRate: denom > 0 ? limitUpCount / denom : null,
    brokenRate: denom > 0 ? brokenCount / denom : null,
    oneWordCount: nonSt.filter((e) => e.isOneWord).length,
    cm20LimitUpCount: nonSt.filter((e) => e.board === 'ChiNext' || e.board === 'STAR').length,
    stLimitUpCount: limitUp.length - nonSt.length,
    heightDist,
    maxHeight,
    maxHeightSymbols,
    board2PlusCount: nonSt.filter((e) => e.consecBoards >= 2).length,
    promotion: yesterdayPool ? computePromotion(yesterdayPool, nonSt) : null,
    yesterdayLimitUpAvgPct: args.yesterdayLimitUpAvgPct,
    yesterdayBrokenAvgPct: args.yesterdayBrokenAvgPct,
  };
}

/** 晉級率 — 用 symbol 對集比對昨日 vs 今日漲停池（皆非 ST）。 */
function computePromotion(
  yesterdayPool: LimitUpPoolDay,
  todayNonSt: LimitUpEntry[],
): NonNullable<LimitUpPoolStats['promotion']> {
  const yNonSt = yesterdayPool.limitUp.filter((e) => !e.isST);
  const todayBySymbol = new Map(todayNonSt.map((e) => [e.symbol, e]));

  const stat = (eligibleSymbols: string[], isPromoted: (today: LimitUpEntry) => boolean): PromotionStat => {
    const eligible = eligibleSymbols.length;
    let promoted = 0;
    for (const sym of eligibleSymbols) {
      const today = todayBySymbol.get(sym);
      if (today && isPromoted(today)) promoted += 1;
    }
    return { eligible, promoted, rate: eligible > 0 ? promoted / eligible : null };
  };

  return {
    d1to2: stat(
      yNonSt.filter((e) => e.consecBoards === 1).map((e) => e.symbol),
      (t) => t.consecBoards === 2,
    ),
    d2to3: stat(
      yNonSt.filter((e) => e.consecBoards === 2).map((e) => e.symbol),
      (t) => t.consecBoards === 3,
    ),
    // 昨 ≥3 板：今日仍在（非 ST）漲停池即算續板（放寬理由見檔頭）
    d3plus: stat(
      yNonSt.filter((e) => e.consecBoards >= 3).map((e) => e.symbol),
      () => true,
    ),
  };
}

// ── 漲停池日檔組裝 ────────────────────────────────────────────────────────────

export function buildLimitUpPoolDay(args: {
  date: string;
  fetchedAt: string;
  source: CnAgentsDataSource;
  limitUp: LimitUpEntry[];
  broken: BrokenEntry[];
  limitDown: LimitDownEntry[];
  breadth: MarketOverview;
  yesterdayPool: LimitUpPoolDay | null;
  yesterdayLimitUpAvgPct: number | null;
  yesterdayBrokenAvgPct: number | null;
}): LimitUpPoolDay {
  return {
    schemaVersion: CN_AGENTS_SCHEMA_VERSION,
    date: args.date,
    fetchedAt: args.fetchedAt,
    source: args.source,
    limitUp: args.limitUp,
    limitDown: args.limitDown,
    broken: args.broken,
    breadth: args.breadth,
    stats: computePoolStats({
      limitUp: args.limitUp,
      broken: args.broken,
      limitDown: args.limitDown,
      yesterdayPool: args.yesterdayPool,
      yesterdayLimitUpAvgPct: args.yesterdayLimitUpAvgPct,
      yesterdayBrokenAvgPct: args.yesterdayBrokenAvgPct,
    }),
  };
}

// ── 市場寬度日線（情緒狀態機輸入）────────────────────────────────────────────

/**
 * LimitUpPoolDay → MarketBreadthDay 扁平化。
 *
 * turnoverHistory = 「今日之前」各交易日兩市成交額（date 升降冪皆可，
 * 內部自行排序）；防呆：date >= pool.date 的列一律剔除，caller 不小心
 * 把今日也塞進來不會重複計算。
 *
 * turnoverRatio5d = 今日 / 近 5 日均（含今日）：
 *   需要今日 turnover 非 null + 歷史有效（非 null）筆數 ≥ 4，否則 null。
 *
 * promotionRateHigh = d2to3 與 d3plus 按 eligible 家數加權合併
 * （= 兩池 promoted 加總 / eligible 加總）；兩池 eligible 皆 0 或
 * promotion 整組缺 → null。
 */
export function buildMarketBreadthDay(args: {
  pool: LimitUpPoolDay;
  turnoverHistory: Array<{ date: string; turnover: number | null }>;
}): MarketBreadthDay {
  const { pool } = args;
  const { stats, breadth } = pool;

  // turnoverRatio5d
  let turnoverRatio5d: number | null = null;
  const today = breadth.turnoverShSzCny;
  if (today != null && today > 0) {
    const prior = args.turnoverHistory
      .filter((h): h is { date: string; turnover: number } => h.turnover != null && h.date < pool.date)
      .sort((a, b) => b.date.localeCompare(a.date))
      .slice(0, 4);
    if (prior.length >= 4) {
      const avg5 = (today + prior.reduce((s, h) => s + h.turnover, 0)) / 5;
      turnoverRatio5d = avg5 > 0 ? today / avg5 : null;
    }
  }

  // promotionRateHigh（昨 2 板以上今晉級率，加權合併）
  let promotionRateHigh: number | null = null;
  if (stats.promotion) {
    const { d2to3, d3plus } = stats.promotion;
    const eligible = d2to3.eligible + d3plus.eligible;
    if (eligible > 0) promotionRateHigh = (d2to3.promoted + d3plus.promoted) / eligible;
  }

  return {
    date: pool.date,
    limitUpCount: stats.limitUpCount,
    limitDownCount: stats.limitDownCount,
    oneWordCount: stats.oneWordCount,
    zhabanCount: stats.brokenCount,
    zhabanRate: stats.brokenRate,
    maxBoardHeight: stats.maxHeight,
    board2PlusCount: stats.board2PlusCount,
    promotionRate1to2: stats.promotion?.d1to2.rate ?? null,
    promotionRateHigh,
    yestLimitUpAvgReturn: stats.yesterdayLimitUpAvgPct,
    yestZhabanAvgReturn: stats.yesterdayBrokenAvgPct,
    upCount: breadth.upCount,
    downCount: breadth.downCount,
    totalTurnover: breadth.turnoverShSzCny,
    turnoverRatio5d,
    shIndexChangePct: breadth.shIndexPct,
  };
}

// ── 昨炸板股今日平均漲跌（虧錢效應）──────────────────────────────────────────

/**
 * 昨日炸板股（非 ST）今日平均漲跌 %。todayPctBySymbol 由 cron 從即時
 * 報價 / L1 當日 bar 組好餵入。對得到 ≥1 檔才回數字，否則 null（不可
 * 回 0 — 0 是「平盤」有語意，缺資料必須是 null）。
 */
export function computeBrokenAvgPctFromQuotes(
  yesterdayBroken: BrokenEntry[],
  todayPctBySymbol: Map<string, number>,
): number | null {
  const pcts: number[] = [];
  for (const e of yesterdayBroken) {
    if (e.isST) continue;
    const pct = todayPctBySymbol.get(e.symbol);
    if (pct != null && Number.isFinite(pct)) pcts.push(pct);
  }
  if (pcts.length === 0) return null;
  return pcts.reduce((s, v) => s + v, 0) / pcts.length;
}
