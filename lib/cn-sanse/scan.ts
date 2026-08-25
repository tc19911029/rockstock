// ============================================================
// 三色資金 — 全市場掃描（陸股 / A股）。Server-only（讀本地檔）。
// ============================================================
import type { Candle } from '@/types';
import { readCandleFile } from '@/lib/datasource/CandleStorageAdapter';
import { CN_STOCKS } from '@/lib/scanner/cnStocks';
import { CN_STOCKS_GEM_STAR } from '@/lib/scanner/cnStocksGemStar';
import { getLimitMovePct } from '@/lib/utils/limitRules';
import { readTurnoverRank, computeTurnoverRankAsOfDate } from '@/lib/scanner/TurnoverRank';
import { TURNOVER_INDEX_TOP_N } from '@/lib/scanner/universeTopN';
import { computeSanSe, evalLatest, type SanSeLevel } from './selectors';
import { evalConditions, isReversalBuy, type ConditionReport } from './conditions';
import { computeIndicators } from '@/lib/indicators';
import { evaluateSixConditions } from '@/lib/analysis/trendAnalysis';
import { ZHU_PURE_BOOK } from '@/lib/strategy/StrategyConfig';

// 相對強弱(RS)基準 = 個股所屬市場指數（對齊 TDX INDEXC）：滬市(.SS)→上證綜指、深市(.SZ)→深證成指。
const INDEX_SYMBOL = '000001.SS';     // 上證綜指（滬市 + 行情日曆來源）
const INDEX_SYMBOL_SZ = '399001.SZ';  // 深證成指（深市 RS 基準；缺檔時 fallback 上證）
const MIN_BARS = 250;

/**
 * 三色 universe 成交額粗篩上限。對齊書本買法 MarketScanner.prefilterByL2 的 TOP_N：
 * 把每日「新鮮且歷史足夠」的個股按掃描日那根 close×volume（成交額）排序，只保留前 N 檔，
 * 剔除冷門/薄量股、聚焦主流大量股。TW 500 / CN 800（與買法同一套數字、同一套精神）。
 * 三色雖是自創因子，但此粗篩純屬「流動性聚焦」、不涉及書本選股規則 → 不違反鐵則 #5。
 * （2026-06-11 曾短暫誤改 10000 全市場，同日依使用者澄清改回；zhuSix 六條件確認欄保留。）
 *
 * 單一事實 = lib/scanner/universeTopN.ts 的 TURNOVER_INDEX_TOP_N（索引收錄深度直接跟著
 * 三色需求走；2026-07-03 前索引寫死 topN=500，CN 三色實際池只有 ~500 檔的 bug 由此修正）。
 */
export const SANSE_TURNOVER_TOP_N: Record<'TW' | 'CN', number> = TURNOVER_INDEX_TOP_N;

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
  shortOversold?: number;
  report: ConditionReport;
  /** 當日成交額名次（1 = 成交額最大；舊固化資料無此欄 → undefined）。 */
  turnoverRank?: number;
  /**
   * 朱老師六條件確認（書本 evaluateSixConditions 對掃描日重算）：core = 前5核心條件全過、
   * total = 0-6 總分。交集回測 2026-06-11：台股「六條件∩三色紅+觸發」d5 +0.31% 優於兩者單獨；
   * 陸股交集無效、僅供參考。舊固化無此欄 → undefined（前端防禦）。
   */
  zhuSix?: { core: boolean; total: number };
}

/** 對掃描日那根算六條件確認欄（純衍生顯示欄；不進三色選股 gate，吃 ZHU_PURE_BOOK 純書本門檻）。 */
export function computeZhuSix(candles: Candle[]): { core: boolean; total: number } {
  const ci = computeIndicators(candles);
  const six = evaluateSixConditions(ci, ci.length - 1, ZHU_PURE_BOOK.thresholds);
  return { core: six.isCoreReady, total: six.totalScore };
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
export function appendTodayBar(cs: Candle[], date: string, bar: IntradayBar): Candle[] {
  const today: Candle = { date, open: bar.open, high: bar.high, low: bar.low, close: bar.close, volume: bar.volume };
  const last = cs[cs.length - 1];
  if (!last || last.date < date) return [...cs, today];
  if (last.date === date) return [...cs.slice(0, -1), today]; // 取代（理論上盤中不該已有）
  return cs; // 封存資料比 today 還新 → 異常，不動
}

/**
 * 板塊 / ST 排除：北交/老三板(8/4/920) + ST 股名。
 * 創業板(30x)/科創(688) 自 2026-06-30 起納入 universe（CN_STOCKS_GEM_STAR，各成交額前 N 檔），
 * 漲停 20% 由 getLimitMovePct 板塊敏感處理、前端掛科創/創業徽章 → 不再排除。
 */
function isExcluded(symbol: string, name: string): boolean {
  const code = symbol.split('.')[0];
  if (/^(8|4|920)/.test(code)) return true;             // 北交所 / 老三板
  if (name.includes('ST') || name.startsWith('*') || name.startsWith('S')) return true; // ST/*ST/S*ST
  if (name.includes('退')) return true;                  // 退市整理
  return false;
}

async function readCandles(symbol: string): Promise<Candle[] | null> {
  // 本地讀 data/candles/CN，Vercel 讀 Blob（Blob-aware adapter）
  const file = await readCandleFile(symbol, 'CN');
  return file?.candles ?? null;
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
  const intraday = opts?.intraday;
  const asOf = intraday ? undefined : opts?.asOfDate;
  const truncate = (cs: Candle[] | null): Candle[] | null =>
    cs && asOf ? cs.filter((c) => c.date <= asOf) : cs;

  // 股票清單：主板 CN_STOCKS + 科創/創業 CN_STOCKS_GEM_STAR（均已進 git，Vercel 也讀得到）。
  const seen = new Set<string>();
  let stocks: StockEntry[] = [...CN_STOCKS, ...CN_STOCKS_GEM_STAR].filter((s) => {
    if (isExcluded(s.symbol, s.name)) return false;
    if (seen.has(s.symbol)) return false; // 清單有同代號重複（不同產業分類），去重
    seen.add(s.symbol);
    return true;
  });

  // 鐵則 #3 粗掃帽：讀「單檔」成交額索引（Blob/FS，由書本 pipeline 每日維護）把 universe
  // 收斂到 top-N，再逐檔精讀 → 不對全市場逐檔讀 Blob（避免 Vercel 超時）。
  //   - asOf 回補：用 as-of 計算（讀候選 K 線算當時排名）
  //   - latest：用最新索引（單檔讀）
  //   - 索引缺（首次部署 / 本地無索引）→ 不收斂、degrade to full（對齊書本 prefilterByL2 降級行為）
  const wantTopN = opts?.topN ?? SANSE_TURNOVER_TOP_N.CN;
  let coarseRanks = new Map<string, number>();
  try {
    if (asOf) {
      coarseRanks = await computeTurnoverRankAsOfDate('CN', stocks, asOf, wantTopN);
    } else {
      const tr = await readTurnoverRank('CN');
      if (tr) coarseRanks = tr.ranks;
    }
  } catch { /* 索引讀取失敗 → degrade to full */ }
  if (coarseRanks.size) {
    stocks = stocks.filter((s) => coarseRanks.has(s.symbol));
  }

  // 大盤指數 → date→close map（asOf 時截斷到該日；盤中時 append 今日即時指數）。
  // 上證(滬市基準 + 行情日曆) + 深證成指(深市基準)；深證缺檔時 fallback 上證。
  let idxCandles = truncate(await readCandles(INDEX_SYMBOL));
  if (!idxCandles || idxCandles.length === 0) throw new Error(`找不到大盤指數 ${INDEX_SYMBOL} 的本地K線`);
  let idxCandlesSZ = truncate(await readCandles(INDEX_SYMBOL_SZ));
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
    const loaded = await Promise.all(batch.map((s) => readCandles(s.symbol)));

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

      // 共振紀錄：≥1 組買點才收（過濾無訊號的大宗，檔案不爆）。
      // 漲停門檻板塊敏感：科創/創業 20%、主板 10%（getLimitMovePct），避免 12% 誤判成漲停。
      const report = evalConditions(candles, indexClose, series, getLimitMovePct('CN', s.symbol));
      if (report.selected) {
        records.push({
          symbol: s.symbol, name: s.name, industry: s.industry ?? '',
          price: lastClose, changePct, report,
          zhuSix: computeZhuSix(candles), // 只對入選紀錄算（~數百檔），不對全市場算
        });
      }
    });
  }

  // 成交額粗篩：只保留 fresh universe 內「掃描日成交額」前 N 檔（對齊書本買法 prefilterByL2 的 TOP_N）。
  // 三色全市場掃 → 取 top-N 剔除冷門薄量股；不足 N 檔則全收。evaluated 即入圍 universe 數。
  const ranks = topTurnoverRanks(freshTurnovers, wantTopN);
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
  // 共振紀錄排序：底反該買(回測兩市場最高把握)最前 → 共振組數高 → 短線上攻強
  keptRecords.sort((a, b) =>
    (isReversalBuy(b.report) ? 1 : 0) - (isReversalBuy(a.report) ? 1 : 0) ||
    b.report.groupBuyCount - a.report.groupBuyCount ||
    b.report.scores.shortAttack - a.report.scores.shortAttack);

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
    turnoverCap: wantTopN,
    counts: { strict: results.strict.length, medium: results.medium.length, loose: results.loose.length },
    results,
    records: keptRecords,
    resonanceCounts,
    sessionType: intraday ? 'intraday' : 'post_close',
    archivedDate: archivedLast,
  };
}
