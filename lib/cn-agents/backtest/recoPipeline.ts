/**
 * 陸股情緒回測 pipeline — 事件結算 + 報酬即時 derive（P2）
 *
 * 結算：events/{date}.json 內 baseline 為 null/pending 的事件 →
 * settleBaseline（lib/backtest/eventBaseline 單一事實：隔日開盤進場、
 * 一字板 no_fill、停牌跳根、隔夜 >25% 污染守衛）→ 凍結寫回。
 *
 * K 線來源（三路）：
 *   - 主板：data/candles/CN/{symbol}.json（L1）
 *   - 創業/科創：data/cn-agents/_klines-cache/{symbol}.json（P1 回填留下的
 *     Tencent qfq 快取）；快取缺或不夠新 → fetchTencentDailyBars 補抓並回寫
 *   - 北交所：無 K 線源 → settleBaseline(null) = no_data（v1 邊界，事件照記）
 *
 * Tencent 快取 bars 無 volume 欄 → BaselineCandle.volume 填 1（佔位非零）：
 * settleBaseline 的「零量扁平根=停牌假根」偵測對 Tencent 序列本來就用不到
 * （Tencent 停牌日直接缺根，不會出假根），填 0 反而會把真實一字板誤判成停牌。
 *
 * 報酬不持久化 — 讀取時 computeEventReturns 即時算（超額 vs 000001.SS）。
 */

import path from 'path';
import { promises as fs } from 'fs';
import { settleBaseline, type BaselineCandle } from '@/lib/backtest/eventBaseline';
import { computeEventReturns, type RecoReturns } from '@/lib/backtest/eventReturns';
import { atomicFsPut } from '@/lib/storage/atomicFsPut';
import { fetchTencentDailyBars, type EmDailyBar } from '../datasource/emDailyKlines';
import { listRecoEventDates, readRecoEvents, saveRecoEvents } from '../storage';
import type { CnRecoEvent } from './recoTypes';
import type { CnBoardKind } from '../types';

const L1_DIR = path.join(process.cwd(), 'data', 'candles', 'CN');
const KLINES_CACHE_DIR = path.join(process.cwd(), 'data', 'cn-agents', '_klines-cache');
/** 成長板快取補抓窗起點（與 P1 回填一致） */
const GROWTH_CACHE_BEG = '20240501';

interface KlinesCacheFile {
  symbol: string;
  fetchedAt: string;
  begYmd8: string;
  endYmd8: string;
  bars: EmDailyBar[];
}

const ymd8 = (iso: string): string => iso.replaceAll('-', '');

function barsToBaseline(bars: EmDailyBar[]): BaselineCandle[] {
  return bars.map((b) => ({ date: b.date, open: b.open, high: b.high, low: b.low, close: b.close, volume: 1 }));
}

async function loadL1Candles(symbol: string): Promise<BaselineCandle[] | null> {
  try {
    const raw = JSON.parse(await fs.readFile(path.join(L1_DIR, `${symbol}.json`), 'utf-8')) as {
      candles?: Array<{ date: string; open: number; high: number; low: number; close: number; volume?: number }>;
    };
    const candles = raw.candles ?? [];
    if (candles.length === 0) return null;
    return candles.map((c) => ({
      date: c.date, open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume ?? 1,
    }));
  } catch {
    return null;
  }
}

/** 成長板：快取優先；缺檔或 endYmd8 不夠新（< needUpToYmd8）→ Tencent 補抓回寫 */
async function loadGrowthCandles(symbol: string, needUpToYmd8: string): Promise<BaselineCandle[] | null> {
  const cachePath = path.join(KLINES_CACHE_DIR, `${symbol}.json`);
  let cache: KlinesCacheFile | null = null;
  try {
    cache = JSON.parse(await fs.readFile(cachePath, 'utf-8')) as KlinesCacheFile;
  } catch { /* miss */ }
  if (cache && cache.endYmd8 >= needUpToYmd8) return barsToBaseline(cache.bars);

  try {
    const beg = cache?.begYmd8 && cache.begYmd8 < GROWTH_CACHE_BEG ? cache.begYmd8 : GROWTH_CACHE_BEG;
    const bars = await fetchTencentDailyBars(symbol, beg, needUpToYmd8);
    if (bars.length > 0 || cache === null) {
      const file: KlinesCacheFile = {
        symbol,
        fetchedAt: new Date().toISOString(),
        begYmd8: beg,
        endYmd8: needUpToYmd8,
        bars,
      };
      await fs.mkdir(KLINES_CACHE_DIR, { recursive: true });
      await atomicFsPut(cachePath, JSON.stringify(file));
      return barsToBaseline(bars);
    }
  } catch { /* 抓取失敗 → 退回舊快取 */ }
  return cache ? barsToBaseline(cache.bars) : null;
}

/** 三路 K 線載入（結算與報酬共用；caller 自帶 memo Map 避免重複讀檔） */
export async function loadCandlesForEvent(
  symbol: string,
  board: CnBoardKind,
  needUpToYmd8: string,
): Promise<BaselineCandle[] | null> {
  if (board === 'BJ') return null;
  if (board === 'ChiNext' || board === 'STAR') return loadGrowthCandles(symbol, needUpToYmd8);
  return loadL1Candles(symbol);
}

export async function loadShIndexCandles(): Promise<BaselineCandle[] | null> {
  return loadL1Candles('000001.SS');
}

// ── 結算 ──────────────────────────────────────────────────────────────────────

export interface SettleStats {
  scanned: number;
  settled: number;
  filled: number;
  noFill: number;
  noData: number;
  pending: number;
}

/**
 * 結算所有 pending 事件（baseline null 或 status='pending'）。
 * @param opts.maxDates 只掃最近 N 個事件日（預設 90）
 */
export async function settlePendingEvents(opts?: { maxDates?: number }): Promise<SettleStats> {
  const stats: SettleStats = { scanned: 0, settled: 0, filled: 0, noFill: 0, noData: 0, pending: 0 };
  const dates = (await listRecoEventDates()).slice(-(opts?.maxDates ?? 90));
  const now = new Date().toISOString();
  const todayYmd8 = ymd8(now.slice(0, 10));
  const candleMemo = new Map<string, BaselineCandle[] | null>();

  for (const date of dates) {
    const file = await readRecoEvents(date);
    if (!file) continue;
    let changed = false;
    for (const e of file.events) {
      if (e.baseline && e.baseline.status !== 'pending') continue;
      stats.scanned++;
      let candles = candleMemo.get(e.symbol);
      if (candles === undefined) {
        candles = await loadCandlesForEvent(e.symbol, e.board, todayYmd8);
        candleMemo.set(e.symbol, candles);
      }
      const baseline = settleBaseline(e.date, candles, now);
      if (baseline.status === 'pending') {
        stats.pending++;
        // pending 不回寫（與 null 等價，省 churn）
        continue;
      }
      e.baseline = baseline;
      changed = true;
      stats.settled++;
      if (baseline.status === 'filled') stats.filled++;
      else if (baseline.status === 'no_fill') stats.noFill++;
      else stats.noData++;
    }
    if (changed) await saveRecoEvents(file);
  }
  return stats;
}

// ── 報酬即時 derive（讀取層） ─────────────────────────────────────────────────

export interface CnRecoEventWithReturns extends CnRecoEvent {
  returns: RecoReturns | null;
}

/** 讀近 N 個事件日並即時算報酬（baseline filled 才有 returns；超額 vs 上證） */
export async function loadEventsWithReturns(days: number): Promise<CnRecoEventWithReturns[]> {
  const dates = (await listRecoEventDates()).slice(-days);
  const todayYmd8 = ymd8(new Date().toISOString().slice(0, 10));
  const index = await loadShIndexCandles();
  const candleMemo = new Map<string, BaselineCandle[] | null>();
  const out: CnRecoEventWithReturns[] = [];

  for (const date of dates) {
    const file = await readRecoEvents(date);
    if (!file) continue;
    for (const e of file.events) {
      let returns: RecoReturns | null = null;
      if (e.baseline?.status === 'filled') {
        let candles = candleMemo.get(e.symbol);
        if (candles === undefined) {
          candles = await loadCandlesForEvent(e.symbol, e.board, todayYmd8);
          candleMemo.set(e.symbol, candles);
        }
        returns = computeEventReturns({ baseline: e.baseline }, candles, index);
      }
      out.push({ ...e, returns });
    }
  }
  return out;
}

/** 該日「當日報價」：收盤 + 當日漲跌幅（vs 前一交易日收盤）。從 K 線即時算。 */
export interface DateQuote {
  close: number;
  changePct: number | null;
}

/** 每日視圖每檔回傳：前瞻報酬 + 當日報價（兩者共用同一份 K 線，只載一次） */
export interface DateRow {
  returns: RecoReturns | null;
  quote: DateQuote | null;
}

/** 從 K 線取「date 當天（或之前最近一根）」的收盤 + 當日漲跌幅 */
function dateQuote(candles: BaselineCandle[] | null, date: string): DateQuote | null {
  if (!candles || candles.length === 0) return null;
  let idx = -1;
  for (let i = candles.length - 1; i >= 0; i--) {
    if (candles[i].date === date) { idx = i; break; }   // 當日精確命中
    if (candles[i].date < date) { idx = i; break; }      // 否則退最近一根（停牌/非交易日）
  }
  if (idx < 0) return null;
  const close = candles[idx].close;
  const prev = idx > 0 ? candles[idx - 1].close : null;
  const changePct = prev && prev > 0 ? +(((close - prev) / prev) * 100).toFixed(2) : null;
  return { close, changePct };
}

/**
 * 算「某一天」一批股票的前瞻報酬 + 當日報價（隔日開盤進場 → d1..d20 + 最高/回撤 + 超額 vs 上證；
 * 外加當日收盤/漲跌幅）。給每日視圖端點用：候選股 + 龍虎榜股都走這個（不論在不在 events 檔）。
 * 一天 ~50–150 檔，逐檔載 K 線 memoize，秒級。報酬不持久化、即時算。
 * @returns Map<code, DateRow>（baseline 非 filled → returns=null；K 線缺 → quote=null）
 */
export async function loadDateReturns(
  date: string,
  items: Array<{ code: string; symbol: string; board: CnBoardKind }>,
): Promise<Map<string, DateRow>> {
  const now = new Date().toISOString();
  const todayYmd8 = ymd8(now.slice(0, 10));
  const index = await loadShIndexCandles();
  const candleMemo = new Map<string, BaselineCandle[] | null>();
  const out = new Map<string, DateRow>();

  for (const it of items) {
    if (out.has(it.code)) continue;
    let candles = candleMemo.get(it.symbol);
    if (candles === undefined) {
      candles = await loadCandlesForEvent(it.symbol, it.board, todayYmd8);
      candleMemo.set(it.symbol, candles);
    }
    const baseline = settleBaseline(date, candles, now);
    const returns = baseline.status === 'filled' ? computeEventReturns({ baseline }, candles, index) : null;
    out.set(it.code, { returns, quote: dateQuote(candles, date) });
  }
  return out;
}
