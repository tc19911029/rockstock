// ============================================================
// 三色資金 — 全市場掃描（陸股 / A股）。Server-only（讀本地檔）。
// ============================================================
import * as fs from 'fs/promises';
import * as path from 'path';
import type { Candle } from '@/types';
import { getLocalCandleDir } from '@/lib/datasource/LocalCandleStore';
import { computeSanSe, evalLatest, type SanSeLevel } from './selectors';
import { evalConditions, type ConditionReport } from './conditions';

// 相對強弱(RS)基準 = 個股所屬市場指數（對齊 TDX INDEXC）：滬市(.SS)→上證綜指、深市(.SZ)→深證成指。
const INDEX_SYMBOL = '000001.SS';     // 上證綜指（滬市 + 行情日曆來源）
const INDEX_SYMBOL_SZ = '399001.SZ';  // 深證成指（深市 RS 基準；缺檔時 fallback 上證）
const MIN_BARS = 250;

/**
 * 三色 universe 成交額粗篩上限。對齊書本買法 MarketScanner.prefilterByL2 的 TOP_N：
 * 把每日「新鮮且歷史足夠」的個股按掃描日那根 close×volume（成交額）排序，只保留前 N 檔，
 * 剔除冷門/薄量股、聚焦主流大量股。TW 500 / CN 800（與買法同一套數字、同一套精神）。
 * 三色雖是自創因子，但此粗篩純屬「流動性聚焦」、不涉及書本選股規則 → 不違反鐵則 #5。
 */
export const SANSE_TURNOVER_TOP_N: Record<'TW' | 'CN', number> = { TW: 500, CN: 800 };

/**
 * 取成交額（close×volume）前 topN：回傳 symbol → 名次（1-based，1 = 當日成交額最大）。
 * 不足 topN 則全收（不誤殺）。回 Map 而非 Set，讓掃描清單能像書本買法顯示「成交量第N名」。
 */
export function topTurnoverRanks(
  items: { symbol: string; turnover: number }[],
  topN: number,
): Map<string, number> {
  const ranks = new Map<string, number>();
  [...items]
    .sort((a, b) => b.turnover - a.turnover)
    .slice(0, topN)
    .forEach((it, i) => ranks.set(it.symbol, i + 1));
  return ranks;
}

export interface SanSeHit {
  symbol: string;
  name: string;
  industry: string;
  price: number;
  changePct: number;
  shortAttack: number;
  midStrength: number;
  midControl: number;
  kongPan: number;
  shortOversold: number;
  /** 當日成交額名次（1 = 成交額最大；對齊書本買法的 turnoverRank。舊固化資料無此欄 → undefined）。 */
  turnoverRank?: number;
}

/** 共振紀錄：≥1 組買點的股票，帶完整三色條件報告（給前端 + 回測） */
export interface ResonanceRecord {
  symbol: string;
  name: string;
  industry: string;
  price: number;      // 掃描當日收盤
  changePct: number;
  report: ConditionReport;
  /** 當日成交額名次（1 = 成交額最大；舊固化資料無此欄 → undefined）。 */
  turnoverRank?: number;
}

export interface ResonanceCounts {
  strong: number; medium: number; weak: number; observe: number; conflict: number;
}

export interface SanSeScanResult {
  lastDate: string;
  scannedAt: string;
  evaluated: number;
  staleSkipped: number;
  /** 成交額粗篩剔除的檔數（新鮮但落在 top-N 之外的冷門薄量股）。 */
  turnoverFiltered?: number;
  /** 成交額粗篩上限（top-N，TW 500 / CN 800）。 */
  turnoverCap?: number;
  counts: Record<SanSeLevel, number>;
  results: Record<SanSeLevel, SanSeHit[]>;
  records: ResonanceRecord[];       // 共振紀錄（入選∪指標買點）
  resonanceCounts: ResonanceCounts;
  /** 'post_close' = 盤後封存（預設）；'intraday' = 盤中即時（量能半根、訊號會跳動） */
  sessionType?: 'post_close' | 'intraday';
  /** 封存日K的最後一天（盤中模式 = 前一交易日；盤後模式 = lastDate）。前端判走圖是否真落後用。 */
  archivedDate?: string;
}

interface StockEntry { symbol: string; name: string; industry?: string }

/** 盤中即時 K 棒（合成當日進行中那根，append 到封存日K尾巴） */
export interface IntradayBar { open: number; high: number; low: number; close: number; volume: number }

/**
 * 盤中即時輸入：把 L2 快照當作「今日未收的那根日K」貼上去重算三色。
 * 量能不完整 → 訊號整天會跳動，越接近收盤越接近真值。
 */
export interface SanSeIntradayInput {
  date: string;                            // 今日交易日 YYYY-MM-DD（snapshot.date）
  quotes: Map<string, IntradayBar>;        // key = 純 6 位代碼（不含 .SS/.SZ）
  indexBars: Map<string, IntradayBar>;     // 今日指數即時 OHLCV，key = '000001.SS' / '399001.SZ'（RS 基準）
}

/** 把今日即時報價合成一根日K append 到封存序列尾端（已有今日就取代；封存比今日新則不動）。 */
function appendTodayBar(cs: Candle[], date: string, bar: IntradayBar): Candle[] {
  const today: Candle = { date, open: bar.open, high: bar.high, low: bar.low, close: bar.close, volume: bar.volume };
  const last = cs[cs.length - 1];
  if (!last || last.date < date) return [...cs, today];
  if (last.date === date) return [...cs.slice(0, -1), today]; // 取代（理論上盤中不該已有）
  return cs; // 封存資料比 today 還新 → 異常，不動
}

/** 板塊 / ST 排除：創業板(30x) + 科創(688) + 北交/老三板(8/4) + ST 股名。 */
function isExcluded(symbol: string, name: string): boolean {
  const code = symbol.split('.')[0];
  if (/^(30|688|8|4)/.test(code)) return true;          // 創業板 / 科創 / 北交
  if (name.includes('ST') || name.startsWith('*') || name.startsWith('S')) return true; // ST/*ST/S*ST
  if (name.includes('退')) return true;                  // 退市整理
  return false;
}

async function readCandles(dir: string, symbol: string): Promise<Candle[] | null> {
  try {
    const raw = await fs.readFile(path.join(dir, `${symbol}.json`), 'utf8');
    const data = JSON.parse(raw);
    return Array.isArray(data?.candles) ? (data.candles as Candle[]) : null;
  } catch {
    return null;
  }
}

/**
 * 全市場掃描。
 * @param opts.asOfDate 若給定（YYYY-MM-DD），把所有 K 線截斷到 ≤ 該日重算（歷史回補用）；
 *                      不給則用最新交易日（即時掃）。
 * @param opts.intraday 若給定，把 L2 即時報價合成「今日未收的那根日K」append 到封存序列重算
 *                      （盤中模式）。與 asOfDate 互斥。沒有即時報價的個股 last 仍停在前一交易日
 *                      → 被既有新鮮度檢查當殭屍股跳過（正確：無即時資料不選）。
 */
export async function scanSanSe(opts?: { asOfDate?: string; intraday?: SanSeIntradayInput; topN?: number }): Promise<SanSeScanResult> {
  const root = process.cwd();
  const dir = getLocalCandleDir('CN');
  const intraday = opts?.intraday;
  const asOf = intraday ? undefined : opts?.asOfDate;
  const truncate = (cs: Candle[] | null): Candle[] | null =>
    cs && asOf ? cs.filter((c) => c.date <= asOf) : cs;

  // 股票清單
  const listRaw = await fs.readFile(path.join(root, 'data/cn_stocklist.json'), 'utf8');
  const seen = new Set<string>();
  const stocks: StockEntry[] = (JSON.parse(listRaw).stocks ?? []).filter((s: StockEntry) => {
    if (isExcluded(s.symbol, s.name)) return false;
    if (seen.has(s.symbol)) return false; // 清單有同代號重複（不同產業分類），去重
    seen.add(s.symbol);
    return true;
  });

  // 大盤指數 → date→close map（asOf 時截斷到該日；盤中時 append 今日即時指數）。
  // 上證(滬市基準 + 行情日曆) + 深證成指(深市基準)；深證缺檔時 fallback 上證。
  let idxCandles = truncate(await readCandles(dir, INDEX_SYMBOL));
  if (!idxCandles || idxCandles.length === 0) throw new Error(`找不到大盤指數 ${INDEX_SYMBOL} 的本地K線`);
  let idxCandlesSZ = truncate(await readCandles(dir, INDEX_SYMBOL_SZ));
  // 盤中：append 前先記下「封存前一交易日」= 指數封存最後一根。個股只有封存對齊到這天才貼今日，
  // 否則（停牌復牌 / 下載漏昨日）封存有缺口，貼今日會算出跨缺口的失真 MA/SUM → 用此 base 把它擋掉。
  const archivedLast = idxCandles[idxCandles.length - 1]?.date ?? '';
  if (intraday) {
    const shBar = intraday.indexBars.get(INDEX_SYMBOL);
    if (shBar) idxCandles = appendTodayBar(idxCandles, intraday.date, shBar);
    const szBar = intraday.indexBars.get(INDEX_SYMBOL_SZ);
    if (idxCandlesSZ && idxCandlesSZ.length > 0 && szBar) idxCandlesSZ = appendTodayBar(idxCandlesSZ, intraday.date, szBar);
  }
  const idxMapSH = new Map<string, number>(idxCandles.map((c) => [c.date, c.close]));
  const idxMapSZ = (idxCandlesSZ && idxCandlesSZ.length > 0)
    ? new Map<string, number>(idxCandlesSZ.map((c) => [c.date, c.close]))
    : idxMapSH; // 深證成指缺檔 → 退回上證（維持舊行為，不中斷）
  const lastDate = idxCandles[idxCandles.length - 1]?.date ?? '';

  const results: Record<SanSeLevel, SanSeHit[]> = { strict: [], medium: [], loose: [] };
  const records: ResonanceRecord[] = [];
  const freshTurnovers: { symbol: string; turnover: number }[] = [];
  let staleSkipped = 0;

  const BATCH = 100;
  for (let i = 0; i < stocks.length; i += BATCH) {
    const batch = stocks.slice(i, i + BATCH);
    const loaded = await Promise.all(batch.map((s) => readCandles(dir, s.symbol)));

    batch.forEach((s, k) => {
      let candles = truncate(loaded[k]);
      // 盤中：把今日即時報價貼成進行中那根日K。只有「封存最後一根 === 前一交易日」才貼，
      // 避免停牌復牌 / 下載漏昨日的缺口序列被貼成今日卻通過新鮮度檢查（指標跨缺口失真）。
      // 無即時報價、或封存有缺口者保持原樣 → 下方新鮮度檢查淘汰（staleSkipped）。
      if (candles && intraday && candles[candles.length - 1]?.date === archivedLast) {
        const bar = intraday.quotes.get(s.symbol.split('.')[0]);
        if (bar) candles = appendTodayBar(candles, intraday.date, bar);
      }
      if (!candles || candles.length < MIN_BARS) return;
      // 資料新鮮度：最後一根必須是該掃描日（asOf 或最新），否則是停牌/退市殭屍股，不納入選股
      if (candles[candles.length - 1].date !== lastDate) { staleSkipped++; return; }
      // 成交額粗篩用：掃描日那根 close×volume（盤中=今日半根、盤後=整日）；實際 top-N 篩在迴圈後。
      const lastBar = candles[candles.length - 1];
      freshTurnovers.push({ symbol: s.symbol, turnover: (lastBar.close ?? 0) * (lastBar.volume ?? 0) });

      // 對齊「個股所屬市場指數」收盤（深市.SZ→深證成指、滬市.SS→上證；前向填補，開頭缺口留 NaN）
      const homeIdx = s.symbol.endsWith('.SZ') ? idxMapSZ : idxMapSH;
      let last = NaN;
      const indexClose = candles.map((c) => {
        const v = homeIdx.get(c.date);
        if (v != null) last = v;
        return last;
      });

      const series = computeSanSe(candles, indexClose);
      const prevClose = candles[candles.length - 2]?.close;
      const lastClose = candles[candles.length - 1]?.close ?? 0;
      const changePct = prevClose ? +(((lastClose - prevClose) / prevClose) * 100).toFixed(2) : 0;

      const strategies: SanSeLevel[] = [];
      (['strict', 'medium', 'loose'] as SanSeLevel[]).forEach((lv) => {
        const r = evalLatest(series, lv);
        if (r.hit) {
          strategies.push(lv);
          results[lv].push({
            symbol: s.symbol,
            name: s.name,
            industry: s.industry ?? '',
            price: lastClose,
            changePct,
            shortAttack: r.shortAttack,
            midStrength: r.midStrength,
            midControl: r.midControl,
            kongPan: r.kongPan,
            shortOversold: r.shortOversold,
          });
        }
      });

      // 共振紀錄：≥1 組買點才收（過濾無訊號的大宗，檔案不爆）
      const report = evalConditions(candles, indexClose, series);
      if (report.selected) {
        records.push({
          symbol: s.symbol, name: s.name, industry: s.industry ?? '',
          price: lastClose, changePct, report,
        });
      }
    });
  }

  // 成交額粗篩：只保留 fresh universe 內「掃描日成交額」前 N 檔（對齊書本買法 prefilterByL2 的 TOP_N）。
  // 三色全市場掃 → 取 top-N 剔除冷門薄量股；不足 N 檔則全收。evaluated 即入圍 universe 數。
  const topN = opts?.topN ?? SANSE_TURNOVER_TOP_N.CN;
  const ranks = topTurnoverRanks(freshTurnovers, topN);
  const evaluated = ranks.size;
  const turnoverFiltered = freshTurnovers.length - ranks.size;
  (['strict', 'medium', 'loose'] as SanSeLevel[]).forEach((lv) => {
    results[lv] = results[lv]
      .filter((h) => ranks.has(h.symbol))
      .map((h) => ({ ...h, turnoverRank: ranks.get(h.symbol) }));
  });
  const keptRecords = records
    .filter((r) => ranks.has(r.symbol))
    .map((r) => ({ ...r, turnoverRank: ranks.get(r.symbol) }));

  // 排序：短线上攻強者在前
  (['strict', 'medium', 'loose'] as SanSeLevel[]).forEach((lv) =>
    results[lv].sort((a, b) => b.shortAttack - a.shortAttack),
  );
  // 共振紀錄排序：共振組數高→短線上攻強
  keptRecords.sort((a, b) => b.report.groupBuyCount - a.report.groupBuyCount || b.report.scores.shortAttack - a.report.scores.shortAttack);

  const resonanceCounts: ResonanceCounts = {
    strong: keptRecords.filter((r) => r.report.level === 'strong').length,
    medium: keptRecords.filter((r) => r.report.level === 'medium').length,
    weak: keptRecords.filter((r) => r.report.level === 'weak').length,
    observe: keptRecords.filter((r) => !r.report.mainforce.buyHit).length, // 純指標、主力未入選
    conflict: keptRecords.filter((r) => r.report.conflict).length,
  };

  return {
    lastDate,
    scannedAt: new Date().toISOString(),
    evaluated,
    staleSkipped,
    turnoverFiltered,
    turnoverCap: topN,
    counts: { strict: results.strict.length, medium: results.medium.length, loose: results.loose.length },
    results,
    records: keptRecords,
    resonanceCounts,
    sessionType: intraday ? 'intraday' : 'post_close',
    archivedDate: archivedLast,
  };
}
