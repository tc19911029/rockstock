/**
 * 陸股板塊成分股逐檔績效（/cn-sectors 點開板塊的績效格）— 2026-06-19，lazy on-demand
 *
 * 板塊成分股清單沒存檔（boards/{date}.json 每板塊只存領漲股一檔），點開才即時抓：
 *   1. fetchBoardMembers(BKxxxx) 取全量成分股（當日漲跌幅 + 成交額）
 *   2. 依成交額排序取前 MAX_MEMBERS 檔（概念板塊常上百檔，全抓 K 線太重）
 *   3. 每檔抓 Tencent 前復權日K（_klines-cache 截止 ~6/3 已 stale，一律抓 fresh），
 *      算 1~10/20 日「滾動報酬」r_n = close[D]/close[D−n] − 1，對齊 PERF_PERIODS
 *
 * 為什麼走 Tencent 不讀 cache：cache 的 endYmd8 停在回填當時（2026-06-03），算不出近 20 日
 * 報酬；Tencent qfq 是本 repo CN 日K 可信源（見 emDailyKlines 檔頭 + 除權息修復先例）。
 * API 層（/api/cn-sectors/board-members）有 5 分鐘記憶體快取，避免點開重抓。
 *
 * 純顯示層，不參與選股（鐵則 #5）。
 */

import { fetchBoardMembers } from './datasource/emBoards';
import { fetchTencentDailyBars } from './datasource/emDailyKlines';
import { fetchCapitalFlow, type CapitalFlowDay } from '@/lib/datasource/EastMoneyCapitalFlow';
import { fetchCnMarginHistory, type CnMarginDay } from './datasource/emMarginBalance';
import { PERF_PERIODS, INST_PERIODS } from '@/lib/themes/perfPeriods';
import { shiftDateYmd } from '@/lib/dateDefaults';
import { evaluateStockSignal, type StockSignal } from '@/lib/analysis/stockSignal';

/** 一檔成分股的當日狀態 + 1~10/20 日滾動報酬（rets 對齊 PERF_PERIODS） */
export interface CnMemberPerf {
  code: string;
  name: string;
  symbol: string;
  /** 當日漲跌幅 %（EM clist f3，即時） */
  changePercent: number;
  turnoverCny: number | null;
  /** 主力淨流入（元，EM f62 當日；A股「法人」對應—東財大單推估） */
  mainNetCny: number | null;
  /** 主力淨流入 N 日累計（元；EM 資金流日K 主力大+超大單），index 對齊 INST_PERIODS（缺 → null） */
  mainFlow: (number | null)[];
  /** 兩融（融資融券）餘額 N 日變化（元），index 對齊 INST_PERIODS（缺 → null） */
  marginChg: (number | null)[];
  /** 過去 N 日滾動報酬 %，index 對齊 PERF_PERIODS（缺資料 → null） */
  rets: (number | null)[];
  /** 六大進場條件 + 趨勢（朱老師書本同一支判讀，純顯示；K 線不足 → null） */
  signal?: StockSignal | null;
}

export interface CnBoardMembersFile {
  boardCode: string;
  date: string;
  /** 板塊成分股總數（抓到的全量，未截斷） */
  totalMembers: number;
  /** 實際算績效的檔數（≤ MAX_MEMBERS） */
  shown: number;
  members: CnMemberPerf[];
}

/** 成分股太多 → 只取成交額前 N 檔算 K 線（UI 標示「顯示前 N 檔」） */
const MAX_MEMBERS = 40;
const CONCURRENCY = 8;
/** 抓 K 線往前的日曆天數（要蓋住六條件 MA60 + 結構轉折 ~100 交易日；報酬只用近 20 根不受影響） */
const KLINE_LOOKBACK_DAYS = 160;

const stripDashes = (ymd: string) => ymd.replace(/-/g, '');

/**
 * 由日K（升冪）算滾動報酬。anchor = date 當日 bar；該日停牌無 bar → 取最後一根
 * date 之前（含）的 bar 當 anchor，名次照交易日序回退。
 */
function computeRets(bars: { date: string; close: number }[], date: string): (number | null)[] {
  // anchor = 最後一根 date <= 目標日 的 bar
  let anchorIdx = -1;
  for (let i = 0; i < bars.length; i++) {
    if (bars[i].date <= date) anchorIdx = i;
    else break;
  }
  if (anchorIdx < 0) return PERF_PERIODS.map(() => null);
  const anchorClose = bars[anchorIdx].close;
  return PERF_PERIODS.map((p) => {
    const j = anchorIdx - p;
    if (j < 0) return null;
    const prev = bars[j].close;
    if (!(prev > 0)) return null;
    return +((anchorClose / prev - 1) * 100).toFixed(2);
  });
}

/** 主力淨流入 N 日累計（元）：anchor = 最後一筆 date<=目標日，sum 近 n 筆（含 anchor）。對齊 INST_PERIODS。 */
function flowSums(flow: CapitalFlowDay[], date: string): (number | null)[] {
  const asc = [...flow].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  let ai = -1;
  for (let i = 0; i < asc.length; i++) { if (asc[i].date <= date) ai = i; else break; }
  if (ai < 0) return INST_PERIODS.map(() => null);
  return INST_PERIODS.map((n) => {
    const start = ai - n + 1;
    if (start < 0) return null;
    let s = 0;
    for (let i = start; i <= ai; i++) s += asc[i].mainNet;
    return Math.round(s);
  });
}

/** 兩融餘額 N 日變化（元）：anchor 餘額 − n 筆前餘額（margin 已升冪）。對齊 INST_PERIODS。 */
function marginChgs(margin: CnMarginDay[], date: string): (number | null)[] {
  let ai = -1;
  for (let i = 0; i < margin.length; i++) { if (margin[i].date <= date) ai = i; else break; }
  if (ai < 0) return INST_PERIODS.map(() => null);
  const anchor = margin[ai].rzrqYe;
  return INST_PERIODS.map((n) => {
    const j = ai - n;
    if (j < 0) return null;
    return Math.round(anchor - margin[j].rzrqYe);
  });
}

/** concurrency-limited map（簡易批次池，避免 Tencent 同 IP 並發轟炸） */
async function mapPool<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let cursor = 0;
  async function worker() {
    for (;;) {
      const i = cursor++;
      if (i >= items.length) return;
      out[i] = await fn(items[i]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()));
  return out;
}

/**
 * 組某板塊成分股逐檔績效。板塊抓不到成分股 → totalMembers=0、members=[]（不 throw，
 * 讓 UI 顯示「抓不到成分股」而非整頁壞）。
 */
export async function buildBoardMembersPerf(boardCode: string, date: string): Promise<CnBoardMembersFile> {
  let members: Awaited<ReturnType<typeof fetchBoardMembers>>;
  try {
    members = await fetchBoardMembers(boardCode);
  } catch {
    return { boardCode, date, totalMembers: 0, shown: 0, members: [] };
  }
  const totalMembers = members.length;
  const top = [...members]
    .sort((a, b) => (b.turnoverCny ?? -Infinity) - (a.turnoverCny ?? -Infinity))
    .slice(0, MAX_MEMBERS);

  const begYmd8 = stripDashes(shiftDateYmd(date, -KLINE_LOOKBACK_DAYS));
  const endYmd8 = stripDashes(date);

  const perf = await mapPool(top, CONCURRENCY, async (m): Promise<CnMemberPerf> => {
    // 三路並行：日K（漲幅）＋資金流（主力）＋兩融餘額。任一失敗只讓該欄空，不壞整檔。
    const [bars, flow, margin] = await Promise.all([
      fetchTencentDailyBars(m.symbol, begYmd8, endYmd8).catch(() => null),
      fetchCapitalFlow(m.symbol, 40).catch(() => [] as CapitalFlowDay[]),
      fetchCnMarginHistory(m.code, 40).catch(() => [] as CnMarginDay[]),
    ]);
    return {
      code: m.code,
      name: m.name,
      symbol: m.symbol,
      changePercent: m.pct,
      turnoverCny: m.turnoverCny,
      mainNetCny: m.mainNetCny,
      mainFlow: flowSums(flow ?? [], date),
      marginChg: marginChgs(margin ?? [], date),
      rets: bars ? computeRets(bars, date) : PERF_PERIODS.map(() => null),
    };
  });

  return { boardCode, date, totalMembers, shown: perf.length, members: perf };
}
