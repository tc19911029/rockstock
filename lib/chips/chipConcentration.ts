/**
 * 主力籌碼集中度（跟看盤 app 對齊版）— FinMind 券商分點逐日明細算正式公式。
 *
 * 公式（使用者 CMoney 課程筆記，docs/cmoney_chip_course_notes.md）：
 *   集中度(N日) =（區間「買超前15大券商」合計 − 區間「賣超前15大券商」合計）÷ N日成交量(張) × 100
 *   前15大 = 整個區間排名（非每日 top15 加總）。
 *
 * 資料：FinMind `TaiwanStockTradingDailyReport`（全分點、含當天）。每日明細逐日快取
 * （封存日永久、今日 TTL），視窗在程式端彙總 → 任意週期/日期皆精確。分母走 L1 成交量(=FinMind 官方)。
 * 純顯示，不改任何選股 gate。實測微星/力智 5日 與看盤 app 對上（含當天）。
 */
import { promises as fs } from 'fs';
import path from 'path';
import { fetchFinMindBranchDay } from '@/lib/datasource/FinMindBranchProvider';

const CACHE_DIR = path.join(process.cwd(), 'data', 'chips', 'TW', 'finmind-branch');
const TODAY_TTL_MS = 20 * 60_000;
const CONCURRENCY = 3;
const KEEP_DAYS = 60; // 快取最多留近 60 個交易日（控檔案大小）

type DayCache = Record<string, { net: Record<string, number>; at: number }>;

export interface ConcPoint { date: string; c5: number | null; c20: number | null; net: number | null }

async function loadCache(code: string): Promise<DayCache> {
  try { return JSON.parse(await fs.readFile(path.join(CACHE_DIR, `${code}.json`), 'utf8')); }
  catch { return {}; }
}
async function saveCache(code: string, c: DayCache): Promise<void> {
  // 只留最近 KEEP_DAYS 天，避免檔案無限長大
  const dates = Object.keys(c).sort();
  if (dates.length > KEEP_DAYS) for (const d of dates.slice(0, dates.length - KEEP_DAYS)) delete c[d];
  await fs.mkdir(CACHE_DIR, { recursive: true });
  await fs.writeFile(path.join(CACHE_DIR, `${code}.json`), JSON.stringify(c));
}

/** 區間分點淨買賣超(張) Map → 集中度%（前15大買超 − 前15大賣超 ÷ 區間量） */
function concFromNets(branchNet: Map<string, number>, volK: number): number | null {
  if (!(volK > 0) || branchNet.size === 0) return null;
  const v = [...branchNet.values()];
  const top15buy = v.filter((x) => x > 0).sort((a, b) => b - a).slice(0, 15).reduce((a, b) => a + b, 0);
  const top15sell = v.filter((x) => x < 0).sort((a, b) => a - b).slice(0, 15).reduce((a, b) => a + b, 0);
  return +(((top15buy + top15sell) / volK) * 100).toFixed(2);
}

/** 當日「主力分點淨買賣超」(張) = 當日前15大買超合計 + 前15大賣超合計（與集中度同口徑、同源）。
 *  分點明細缺 → null（結算中），不退回 Yahoo 的當日快照（那個只有當天、又被 250 檔上限砍）。 */
export function dailyNetFromBranch(branchNet: Map<string, number> | undefined): number | null {
  if (!branchNet || branchNet.size === 0) return null;
  const v = [...branchNet.values()];
  const top15buy = v.filter((x) => x > 0).sort((a, b) => b - a).slice(0, 15).reduce((a, b) => a + b, 0);
  const top15sell = v.filter((x) => x < 0).sort((a, b) => a - b).slice(0, 15).reduce((a, b) => a + b, 0);
  return Math.round(top15buy + top15sell);
}

/**
 * @param candles 升冪日K（date + volume(張)）
 * @param opts.periods 要算的兩個視窗（預設 [5,20]）；recentN 最近幾根；todayDate 最新交易日(那根用 TTL)
 */
export async function computeConcSeries(
  code: string,
  candles: { date: string; volume: number }[],
  opts: { periods?: [number, number]; recentN?: number; todayDate?: string } = {},
): Promise<ConcPoint[]> {
  const periods = opts.periods ?? [5, 20];
  const recentN = opts.recentN ?? 10;
  const maxP = Math.max(...periods);
  const n = candles.length;
  if (n < maxP) return [];

  const startIdx = Math.max(maxP - 1, n - recentN);
  const firstDayIdx = Math.max(0, startIdx - maxP + 1); // 最舊視窗需要的第一天
  const cache = await loadCache(code);
  let dirty = false;
  const now = Date.now();

  // ── 逐日抓分點明細（封存日快取永久；今日 TTL）→ date → branch→net(張) ──
  const dayNet = new Map<string, Map<string, number>>();
  const idxs: number[] = [];
  for (let i = firstDayIdx; i < n; i++) idxs.push(i);
  for (let s = 0; s < idxs.length; s += CONCURRENCY) {
    await Promise.all(idxs.slice(s, s + CONCURRENCY).map(async (i) => {
      const d = candles[i].date;
      const isToday = !!opts.todayDate && d === opts.todayDate;
      const c = cache[d];
      if (c && (!isToday || now - c.at < TODAY_TTL_MS)) {
        dayNet.set(d, new Map(Object.entries(c.net)));
        return;
      }
      const net = await fetchFinMindBranchDay(code, d);
      if (net.size > 0) {
        cache[d] = { net: Object.fromEntries(net), at: now };
        dirty = true;
        dayNet.set(d, net);
      } else if (c) {
        dayNet.set(d, new Map(Object.entries(c.net))); // 抓不到 → 用舊快取
      }
      // net 空且無舊快取 → 該日缺，視窗會回 null（結算中）
    }));
  }
  if (dirty) await saveCache(code, cache).catch(() => { /* 寫快取失敗不阻斷 */ });

  // ── 視窗彙總（任一日缺 → null=結算中，不給殘窗 garbage）──
  const out: ConcPoint[] = [];
  const calc = (i: number, p: number): number | null => {
    if (i - p + 1 < 0) return null;
    const agg = new Map<string, number>();
    let volK = 0;
    for (let k = i - p + 1; k <= i; k++) {
      const dn = dayNet.get(candles[k].date);
      if (!dn) return null;
      for (const [br, v] of dn) agg.set(br, (agg.get(br) ?? 0) + v);
      volK += candles[k].volume || 0;
    }
    return concFromNets(agg, volK);
  };
  for (let i = startIdx; i < n; i++) {
    out.push({
      date: candles[i].date,
      c5: calc(i, periods[0]),
      c20: calc(i, periods[1]),
      net: dailyNetFromBranch(dayNet.get(candles[i].date)),
    });
  }
  return out;
}

/**
 * 給「選股訊號」用：回最近 count 根的 win 日集中度 Map<date, conc|null>。
 * 與顯示表同一套 FinMind 正式公式 → 條件面板/掃描/顯示三方統一。資料不齊回 null。
 */
export async function computeConc5Map(
  code: string,
  candles: { date: string; volume: number }[],
  opts: { win?: number; count?: number; todayDate?: string } = {},
): Promise<Map<string, number | null>> {
  const win = opts.win ?? 5;
  const count = opts.count ?? 7;
  const n = candles.length;
  const out = new Map<string, number | null>();
  if (n < win) return out;
  const startIdx = Math.max(win - 1, n - count);
  const firstDayIdx = Math.max(0, startIdx - win + 1);
  const cache = await loadCache(code);
  let dirty = false;
  const now = Date.now();

  const dayNet = new Map<string, Map<string, number>>();
  const idxs: number[] = [];
  for (let i = firstDayIdx; i < n; i++) idxs.push(i);
  for (let s = 0; s < idxs.length; s += CONCURRENCY) {
    await Promise.all(idxs.slice(s, s + CONCURRENCY).map(async (i) => {
      const d = candles[i].date;
      const isToday = !!opts.todayDate && d === opts.todayDate;
      const c = cache[d];
      if (c && (!isToday || now - c.at < TODAY_TTL_MS)) { dayNet.set(d, new Map(Object.entries(c.net))); return; }
      const net = await fetchFinMindBranchDay(code, d);
      if (net.size > 0) { cache[d] = { net: Object.fromEntries(net), at: now }; dirty = true; dayNet.set(d, net); }
      else if (c) dayNet.set(d, new Map(Object.entries(c.net)));
    }));
  }
  if (dirty) await saveCache(code, cache).catch(() => { /* 寫快取失敗不阻斷 */ });

  for (let i = startIdx; i < n; i++) {
    const agg = new Map<string, number>();
    let volK = 0, ok = true;
    for (let k = i - win + 1; k <= i; k++) {
      const dn = dayNet.get(candles[k].date);
      if (!dn) { ok = false; break; }
      for (const [br, v] of dn) agg.set(br, (agg.get(br) ?? 0) + v);
      volK += candles[k].volume || 0;
    }
    out.set(candles[i].date, ok ? concFromNets(agg, volK) : null);
  }
  return out;
}
