// ============================================================
// 三色資金 — 台股全市場掃描。Server-only（讀本地檔）。
//
// 這是 lib/cn-sanse/scan.ts 的台股 fork：
//   - K 線讀 data/candles/TW/{symbol}.json
//   - RS 基準 / 行情日曆 = 加權指數 ^TWII（台股單一指數，無滬深雙基準）
//   - 股票池 = 本地 TW 候選清單（4 位數普通股，排除 ETF 00xx / 權證 / 全字母碼）
//
// 條件/選股/評分邏輯 100% 複用 lib/cn-sanse/（市場無關，純 OHLCV + 指數）。
// 刻意與陸股掃描分離（不動到今晚會跑的 cn-sanse cron）。
//
// ⚠️ 三色是自創因子。這支只供「回測 / 探索」用，**尚未**接進台股 production 掃描鏈路
//    或書本選股路徑（鐵則 #5：台股選股只用書本規則）。是否 promote 由使用者決定。
// ============================================================
import * as fs from 'fs/promises';
import * as path from 'path';
import type { Candle } from '@/types';
import { readCandleFile, listCandleSymbols } from '@/lib/datasource/CandleStorageAdapter';
import { readTurnoverRank, computeTurnoverRankAsOfDate } from '@/lib/scanner/TurnoverRank';
import { getTWConcept, fetchTWIndustryMap } from '@/lib/scanner/conceptMap';
import { computeSanSe, evalLatest, type SanSeLevel } from '@/lib/cn-sanse/selectors';
import { evalConditions, isReversalBuy } from '@/lib/cn-sanse/conditions';
import type {
  SanSeHit, ResonanceRecord, ResonanceCounts, SanSeScanResult, SanSeIntradayInput,
} from '@/lib/cn-sanse/scan';
import { SANSE_TURNOVER_TOP_N, topTurnoverRanks, appendTodayBar, computeZhuSix } from '@/lib/cn-sanse/scan';

const INDEX_SYMBOL = '^TWII';   // 加權指數（RS 基準 + 行情日曆）
const MIN_BARS = 250;

interface StockEntry { symbol: string; name: string; industry?: string }

/** 台股普通股池：4 位數代碼 + .TW/.TWO；排除 ETF(00 開頭)、權證、含字母的碼、指數本身。 */
function isCommonStock(symbol: string): boolean {
  const m = symbol.match(/^(\d{4})\.(TW|TWO)$/);
  if (!m) return false;             // 非 4 位純數字（00400A 等 ETF/特殊碼、^TWII）→ 排除
  if (m[1].startsWith('00')) return false; // ETF
  return true;
}

/** 股票代號 → 中文名 對照（取自 YouTube 模組的 stock-master.json；process 內 cache 一次）。 */
let nameMapCache: Map<string, string> | null = null;
async function loadNameMap(): Promise<Map<string, string>> {
  if (nameMapCache) return nameMapCache;
  const map = new Map<string, string>();
  try {
    const raw = await fs.readFile(path.join(process.cwd(), 'data/youtube/stock-master.json'), 'utf8');
    const entries = (JSON.parse(raw).entries ?? []) as { code: string; name: string }[];
    for (const e of entries) if (e.code && e.name) map.set(e.code, e.name);
  } catch { /* 無 master → name 退回代碼 */ }
  nameMapCache = map;
  return map;
}

async function readCandles(symbol: string): Promise<Candle[] | null> {
  // 本地讀 data/candles/TW，Vercel 讀 Blob；readCandleFile 已自動去除 TWSE 除權息日標記 "*"
  const file = await readCandleFile(symbol, 'TW');
  return file?.candles ?? null;
}

/** 建台股股票池（universe = 已下載 K 線的 symbol：本地讀目錄、Vercel 讀 Blob list；只列檔名不讀內容）。 */
async function loadTwUniverse(): Promise<StockEntry[]> {
  const [symbols, nameMap, industryMap] = await Promise.all([listCandleSymbols('TW'), loadNameMap(), fetchTWIndustryMap()]);
  const out: StockEntry[] = [];
  for (const symbol of symbols) {
    if (!isCommonStock(symbol)) continue;
    const code = symbol.replace(/\.(TW|TWO)$/i, '');
    const name = nameMap.get(code) ?? symbol;
    // 排除存託憑證（外國企業 TDR，名稱含「DR」，非台股普通股；如 9103 美德醫DR）
    if (/DR$/.test(name) || name.includes('-DR')) continue;
    // 產業題材：題材對照優先（蘋果供應鏈/AI伺服器/記憶體…），沒命中退回 TWSE 產業別（金融保險/航運…）。
    // 與書本掃描同一份來源（conceptMap）；fetchTWIndustryMap 網路失敗只少了產業別 fallback，不中斷掃描。
    const industry = getTWConcept(code, industryMap.get(code)) ?? '';
    out.push({ symbol, name, industry });
  }
  return out;
}

/**
 * 台股三色全市場掃描。
 * @param opts.asOfDate 給定則把所有 K 線截斷到 ≤ 該日重算（回測逐日用）；不給用最新交易日。
 * @param opts.intraday 給定則把 L2 即時報價合成「今日未收的那根日K」append 重算（盤中模式）。與 asOfDate 互斥。
 *                      沒有即時報價的個股 last 仍停在前一交易日 → 被新鮮度檢查當殭屍股跳過（正確：無即時資料不選）。
 */
export async function scanTwSanSe(opts?: { asOfDate?: string; topN?: number; intraday?: SanSeIntradayInput }): Promise<SanSeScanResult> {
  const intraday = opts?.intraday;
  const asOf = intraday ? undefined : opts?.asOfDate;
  const truncate = (cs: Candle[] | null): Candle[] | null =>
    cs && asOf ? cs.filter((c) => c.date <= asOf) : cs;

  const seen = new Set<string>();
  let stocks = (await loadTwUniverse()).filter((s) => {
    if (seen.has(s.symbol)) return false;
    seen.add(s.symbol);
    return true;
  });

  // 鐵則 #3 粗掃帽：單檔成交額索引把 universe 收斂到 top-N，再逐檔精讀（不全市場逐檔讀 Blob）。
  //   asOf 回補用 as-of 計算；latest 用最新索引；索引缺 → degrade to full（對齊書本 prefilterByL2）。
  const wantTopN = opts?.topN ?? SANSE_TURNOVER_TOP_N.TW;
  let coarseRanks = new Map<string, number>();
  try {
    if (asOf) {
      coarseRanks = await computeTurnoverRankAsOfDate('TW', stocks, asOf, wantTopN);
    } else {
      const tr = await readTurnoverRank('TW');
      if (tr) coarseRanks = tr.ranks;
    }
  } catch { /* 索引讀取失敗 → degrade to full */ }
  if (coarseRanks.size) {
    stocks = stocks.filter((s) => coarseRanks.has(s.symbol));
  }

  // 加權指數 → date→close map（行情日曆 + RS 基準）。盤中：把今日即時指數 append 成進行中那根。
  let idxCandles = truncate(await readCandles(INDEX_SYMBOL));
  if (!idxCandles || idxCandles.length === 0) throw new Error(`找不到大盤指數 ${INDEX_SYMBOL} 的本地K線`);
  // 盤中 append 前先記「封存前一交易日」= 指數封存最後一根；個股只有封存對齊到這天才貼今日（缺口防護）。
  const archivedLast = idxCandles[idxCandles.length - 1]?.date ?? '';
  if (intraday) {
    const idxBar = intraday.indexBars.get(INDEX_SYMBOL);
    if (idxBar) idxCandles = appendTodayBar(idxCandles, intraday.date, idxBar);
  }
  const idxMap = new Map<string, number>(idxCandles.map((c) => [c.date, c.close]));
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
      // 避免停牌復牌 / 漏抓昨日的缺口序列被貼成今日卻通過新鮮度檢查（指標跨缺口失真）。
      if (candles && intraday && candles[candles.length - 1]?.date === archivedLast) {
        const bar = intraday.quotes.get(s.symbol.split('.')[0]);
        if (bar) candles = appendTodayBar(candles, intraday.date, bar);
      }
      if (!candles || candles.length < MIN_BARS) return;
      // 新鮮度：最後一根必須是掃描日（asOf 或最新），否則停牌/下市殭屍股，不選
      if (candles[candles.length - 1].date !== lastDate) { staleSkipped++; return; }
      // 成交額粗篩用：掃描日那根 close×volume；實際 top-N 篩在迴圈後。
      const lastBar = candles[candles.length - 1];
      freshTurnovers.push({ symbol: s.symbol, turnover: (lastBar.close ?? 0) * (lastBar.volume ?? 0) });

      // 對齊加權指數收盤（前向填補，開頭缺口留 NaN）
      let last = NaN;
      const indexClose = candles.map((c) => {
        const v = idxMap.get(c.date);
        if (v != null) last = v;
        return last;
      });

      const series = computeSanSe(candles, indexClose);
      const prevClose = candles[candles.length - 2]?.close;
      const lastClose = candles[candles.length - 1]?.close ?? 0;
      const changePct = prevClose ? +(((lastClose - prevClose) / prevClose) * 100).toFixed(2) : 0;

      (['strict', 'medium', 'loose'] as SanSeLevel[]).forEach((lv) => {
        const r = evalLatest(series, lv);
        if (r.hit) {
          results[lv].push({
            symbol: s.symbol, name: s.name, industry: s.industry ?? '',
            price: lastClose, changePct,
            shortAttack: r.shortAttack, midStrength: r.midStrength,
            midControl: r.midControl, kongPan: r.kongPan, shortOversold: r.shortOversold,
          });
        }
      });

      const report = evalConditions(candles, indexClose, series);
      if (report.selected) {
        records.push({
          symbol: s.symbol, name: s.name, industry: s.industry ?? '', price: lastClose, changePct, report,
          zhuSix: computeZhuSix(candles), // 六條件確認欄（只對入選紀錄算；台股交集回測有效）
        });
      }
    });
  }

  // 成交額粗篩：只保留 fresh universe 內「掃描日成交額」前 N 檔（對齊書本買法 prefilterByL2 的 TOP_N）。
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

  (['strict', 'medium', 'loose'] as SanSeLevel[]).forEach((lv) =>
    results[lv].sort((a, b) => b.shortAttack - a.shortAttack),
  );
  keptRecords.sort((a, b) =>
    (isReversalBuy(b.report) ? 1 : 0) - (isReversalBuy(a.report) ? 1 : 0) ||
    b.report.groupBuyCount - a.report.groupBuyCount ||
    b.report.scores.shortAttack - a.report.scores.shortAttack);

  const resonanceCounts: ResonanceCounts = {
    strong: keptRecords.filter((r) => r.report.level === 'strong').length,
    medium: keptRecords.filter((r) => r.report.level === 'medium').length,
    weak: keptRecords.filter((r) => r.report.level === 'weak').length,
    observe: keptRecords.filter((r) => !r.report.mainforce.buyHit).length,
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
