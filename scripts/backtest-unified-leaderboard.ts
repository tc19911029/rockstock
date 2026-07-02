/**
 * 統一策略排行榜回測 — 把每個「策略 × 排序」當選股器，量它選到的股票
 * 在「隔日開盤」進場後 d1/d3/d5 收盤的報酬，做成排行榜。
 *
 * 兩個選股引擎、一套 forward 量測：
 *   買法引擎：scanPure(Step-1 池) → scanBuyMethod(B–Q) + scanDeviationExtreme(R)
 *             — 全部走 lib/scanner 正規路徑（不手刻 detector，遵守鐵則 #5/#10）
 *   三色引擎：scanTwSanSe / scanSanSe({asOfDate}) → 強度檔位 + 組合桶
 *   forward：metricsFromLocalCandles（隔日開盤，零 IO / 零 API）
 *
 * 效能：用 ScannerCache 預熱（把記憶體裡 computeIndicators-once 的全序列切片塞進
 *       掃描專用快取），讓 scanner 每日的 K 線載入變成記憶體命中、不重打磁碟。
 *       指標是因果的（第 i 根只看 ≤i），所以「先算全序列再切片」與「先切片再算」等價。
 *
 * 用法：
 *   BACKTEST_WINDOW_DAYS=480 BACKTEST_LABEL=2y MARKET=both ENGINE=both \
 *   NODE_OPTIONS="--max-old-space-size=12288" \
 *   npx tsx scripts/backtest-unified-leaderboard.ts
 *
 *   快速計時探針：MARKET=TW ENGINE=buymethod BACKTEST_WINDOW_DAYS=5 npx tsx ...
 */

import fs from 'fs';
import path from 'path';
import { computeIndicators } from '@/lib/indicators';
import type { CandleWithIndicators } from '@/types';
import { setScannerCache, clearScannerCache, getScannerCacheStats } from '@/lib/datasource/ScannerCache';
import { trackOf, nameOf, ALL_BUY_METHOD_LETTERS } from '@/lib/scanner/buyMethodTracks';
import type { StockEntry } from '@/lib/scanner/MarketScanner';
import type { StockScanResult } from '@/lib/scanner/types';
import { bucketsForRecord, BUCKET_DEFS } from '@/lib/cn-sanse/rankingScore';
import type { ResonanceRecord, SanSeHit } from '@/lib/cn-sanse/scan';
import { buildFeatures, SORT_DEFS, type CandidateFeatures, type SortFactorName } from './_backtest-sort-defs';
import {
  metricsFromLocalCandles, buildRow, buildMarkdown,
  type RawPick, type RowMeta, type PickMetrics,
} from '@/lib/backtest/unifiedLeaderboard';
import type { LeaderboardDoc, LeaderboardRow, Market, Track } from '@/lib/backtest/leaderboardTypes';
import { isIndexSymbol } from '@/lib/utils/symbols';

// ── Config ───────────────────────────────────────────────────────────────────
const WINDOW_DAYS = parseInt(process.env.BACKTEST_WINDOW_DAYS ?? '480', 10) || 480;
const LABEL = process.env.BACKTEST_LABEL ?? '2y';
const FORWARD_TD = parseInt(process.env.FORWARD_TD ?? '32', 10) || 32;
const MIN_PICKS = parseInt(process.env.MIN_PICKS ?? '20', 10) || 20;
const R_TOP_N = parseInt(process.env.R_TOP_N ?? '10', 10) || 10;
const MARKET_FILTER = (process.env.MARKET ?? 'both').toUpperCase(); // TW | CN | BOTH
const ENGINE_FILTER = (process.env.ENGINE ?? 'both').toLowerCase();  // buymethod | sanse | both
// 可選：把視窗 pin 到固定日期區間（重現用），不給則用 index 行事曆末段。
const PIN_START = process.env.BACKTEST_START || '';
const PIN_END = process.env.BACKTEST_END || '';
// 買法候選宇宙：對齊 production lib/scanner/TurnoverRank.ts —— 20 日均成交額 top-500（兩市場同）。
// （舊版用單日 close×volume top-800/CN，比 production 寬，會高估反轉字母 D/F/N/O 觸發次數。）
const TURNOVER_AVG_WINDOW = 20;
const TURNOVER_TOP_N: Record<Market, number> = { TW: 500, CN: 500 };
const INDEX_SYMBOL: Record<Market, string> = { TW: '^TWII', CN: '000001.SS' };

const BUY_LETTERS = ALL_BUY_METHOD_LETTERS.filter((l) => l !== 'A' && l !== 'V'); // B..R (14)
const BUY_SORTS: SortFactorName[] = ['漲幅', '六條件總分', '成交額', '量比', '動能', '換手率', '綜合因子', '乖離率低'];
const R_SORTS: SortFactorName[] = ['乖離率低', '漲幅', '成交額'];

const TIER_LABEL: Record<string, string> = { strict: '三色·嚴格', medium: '三色·中等', loose: '三色·寬鬆' };
const BUCKET_LABEL = new Map(BUCKET_DEFS.map((b) => [b.key, b.label]));

const ROOT = path.join(process.cwd(), 'data');
const CANDLE_ROOT = path.join(ROOT, 'candles');
const OUT_JSON_DIR = path.join(ROOT, 'backtest');
const OUT_MD_DIR = path.join(ROOT, 'backtest-output');
// 2026-06-12（B1）：ENTRY_MODE=next_close 用「隔日收盤」近似朱書 13:25 市價單；
// 預設 next_open 維持原行為。next_close 輸出走獨立檔名，不覆蓋 UI 在讀的生產 JSON。
const ENTRY_MODE = (process.env.ENTRY_MODE ?? 'next_open') as 'next_open' | 'next_close';
const ENTRY_SUFFIX = ENTRY_MODE === 'next_close' ? '-c1325' : '';
const SUFFIX = (LABEL ? `-${LABEL}` : '') + ENTRY_SUFFIX;

// ── In-memory store ────────────────────────────────────────────────────────────
interface SymStore {
  symbol: string;
  name: string;
  c: CandleWithIndicators[];        // computeIndicators 一次；切片即各日歷史
  dateToIdx: Map<string, number>;
}

// 指數代號排除走 canonical isIndexSymbol（lib/utils/symbols.ts 單一事實，含創業板指 399006.SZ 等）。
// 注意 000001.SZ 是「平安银行」(個股) 不是指數 → isIndexSymbol 已正確不排除。

function loadMarketStore(market: Market): Map<string, SymStore> {
  const dir = path.join(CANDLE_ROOT, market);
  const store = new Map<string, SymStore>();
  if (!fs.existsSync(dir)) return store;
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
  process.stdout.write(`  讀 ${market} L1`);
  let n = 0;
  for (const f of files) {
    const symbol = f.replace('.json', '');
    if (isIndexSymbol(symbol)) continue;
    try {
      const raw = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf-8'));
      const rawCandles = Array.isArray(raw) ? raw : raw.candles ?? [];
      const name: string = (raw && raw.name) || symbol;
      if (typeof name === 'string' && name.includes('ST')) continue;
      if (rawCandles.length < 60) continue;
      const mapped = rawCandles.map((c: Record<string, unknown>) => ({
        date: String(c.date ?? '').slice(0, 10),
        open: Number(c.open) || 0, high: Number(c.high) || 0,
        low: Number(c.low) || 0, close: Number(c.close) || 0, volume: Number(c.volume) || 0,
      }));
      const c = computeIndicators(mapped as CandleWithIndicators[]);
      const dateToIdx = new Map<string, number>();
      c.forEach((bar, i) => dateToIdx.set(bar.date.slice(0, 10), i));
      store.set(symbol, { symbol, name, c, dateToIdx });
      if (++n % 400 === 0) process.stdout.write('.');
    } catch { /* skip */ }
  }
  console.log(` → ${store.size} 支`);
  return store;
}

function loadIndexDays(market: Market): string[] {
  const file = path.join(CANDLE_ROOT, market, `${INDEX_SYMBOL[market]}.json`);
  if (!fs.existsSync(file)) throw new Error(`找不到指數 K：${file}`);
  const raw = JSON.parse(fs.readFileSync(file, 'utf-8'));
  const candles = Array.isArray(raw) ? raw : raw.candles ?? [];
  return candles.map((c: { date: string }) => String(c.date).slice(0, 10)).sort();
}

/** 找掃描日對應的 idx（無精確 bar → 最後一根 ≤ 掃描日）。 */
function resolveIdx(s: SymStore, date: string): number | null {
  const exact = s.dateToIdx.get(date);
  if (exact != null) return exact;
  let lo = 0, hi = s.c.length - 1, ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (s.c[mid].date.slice(0, 10) <= date) { ans = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return ans >= 0 ? ans : null;
}

/** 候選宇宙：對齊 production lib/scanner/TurnoverRank.ts —— 取掃描日(含)往前 20 根的
 *  「平均成交額(close×volume)」top-N。不是單日，避免高估反轉字母觸發次數。 */
function turnoverTopN(store: Map<string, SymStore>, date: string, topN: number) {
  const list: { symbol: string; name: string; turnover: number }[] = [];
  for (const s of store.values()) {
    const idx = resolveIdx(s, date);
    if (idx == null) continue;
    const start = Math.max(0, idx - TURNOVER_AVG_WINDOW + 1);
    let sum = 0, n = 0;
    for (let i = start; i <= idx; i++) {
      const b = s.c[i];
      if (b.close > 0 && b.volume > 0) { sum += b.close * b.volume; n++; }
    }
    if (n === 0) continue;
    list.push({ symbol: s.symbol, name: s.name, turnover: sum / n });
  }
  list.sort((a, b) => b.turnover - a.turnover);
  const capped = list.slice(0, topN);
  const stocks: StockEntry[] = capped.map((x) => ({ symbol: x.symbol, name: x.name }));
  const ranks = new Map<string, number>();
  capped.forEach((x, i) => ranks.set(x.symbol, i + 1));
  return { stocks, ranks };
}

/** 預熱 ScannerCache：把每檔 ≤date 的切片塞進掃描快取（命中後 scanner 不打磁碟）。 */
function warmScannerCache(store: Map<string, SymStore>, date: string): void {
  clearScannerCache();
  for (const s of store.values()) {
    const idx = resolveIdx(s, date);
    if (idx == null) continue;
    setScannerCache(s.symbol, date, s.c.slice(0, idx + 1));
  }
}

// ── 每日 forward 量測快取（symbol → metrics，跨字母/排序/桶共用）─────────────────
type MetricResult = { entryOpen: number; m: PickMetrics } | null;
function getMetrics(store: Map<string, SymStore>, symbol: string, date: string, cache: Map<string, MetricResult>): MetricResult {
  if (cache.has(symbol)) return cache.get(symbol)!;
  const s = store.get(symbol);
  let res: MetricResult = null;
  if (s) {
    const idx = resolveIdx(s, date);
    if (idx != null) res = metricsFromLocalCandles(s.c, idx, ENTRY_MODE);
  }
  cache.set(symbol, res);
  return res;
}

// ── 累加器：`${strategyId} ${sortKey}` → { meta, picks[] } ─────────────────
interface Acc { meta: RowMeta; picks: RawPick[] }
function accKey(strategyId: string, sortKey: string): string { return `${strategyId} ${sortKey}`; }

function pushPicks(
  acc: Map<string, Acc>,
  meta: RowMeta,
  date: string,
  sorted: { symbol: string; name: string; metric: NonNullable<MetricResult> }[],
): void {
  const key = accKey(meta.strategyId, meta.sortKey);
  let a = acc.get(key);
  if (!a) { a = { meta, picks: [] }; acc.set(key, a); }
  sorted.forEach((x, i) => {
    a!.picks.push({
      date, rank: i + 1, symbol: x.symbol, name: x.name,
      entryOpen: x.metric.entryOpen, m: x.metric.m,
    });
  });
}

// ════════════════════════════════════════════════════════════════════════════
// 買法引擎
// ════════════════════════════════════════════════════════════════════════════
async function runBuyMethodDay(
  scanner: { scanPure: (t: undefined, d: string) => Promise<unknown>;
             scanBuyMethod: (m: string, s: StockEntry[], d: string) => Promise<StockScanResult[]>;
             scanDeviationExtreme: (s: StockEntry[], d: string, dir: 'long' | 'short', n: number) => Promise<StockScanResult[]> },
  market: Market,
  date: string,
  store: Map<string, SymStore>,
  acc: Map<string, Acc>,
  metricCache: Map<string, MetricResult>,
): Promise<number> {
  const { stocks } = turnoverTopN(store, date, TURNOVER_TOP_N[market]);
  if (stocks.length < 50) return 0;

  // 把 scanPure 的宇宙也收斂到當日成交額 top-N（省 ~4× 全宇宙掃描）：
  // bullish 候選恆 ⊆ top-N，而「某 top-N 股是否過六條件」與其他股無關（六條件是純個股技術），
  // 故 step1池(top-N) ∩ top-N == step1池(全宇宙) ∩ top-N → 選股結果不變，只是少評非 top-N 股。
  (scanner as unknown as { getStockList: () => Promise<StockEntry[]> }).getStockList = async () => stocks;

  // Step-1 池（bullish 字母靠它 gate）— 必須先跑
  await scanner.scanPure(undefined, date);

  // 每檔 features 快取（跨字母/排序共用）
  const featCache = new Map<string, CandidateFeatures | null>();
  const featOf = (r: StockScanResult): CandidateFeatures | null => {
    if (featCache.has(r.symbol)) return featCache.get(r.symbol)!;
    const s = store.get(r.symbol);
    let f: CandidateFeatures | null = null;
    if (s) {
      const idx = s.dateToIdx.get(date);
      if (idx != null) {
        const bar = s.c[idx];
        const ma20 = (bar as { ma20?: number }).ma20;
        const dev = ma20 && ma20 > 0 ? (bar.close - ma20) / ma20 : (r.ma20Deviation ?? 0);
        f = buildFeatures(r.symbol, r.name, s.c, idx, {
          sixConditionsScore: r.sixConditionsScore,
          highWinRateScore: (r as { highWinRateScore?: number }).highWinRateScore,
          deviation: dev,
        });
      }
    }
    featCache.set(r.symbol, f);
    return f;
  };

  let totalPicks = 0;

  // 處理一批 matched 結果 + 一組排序 → 推進累加器
  const handle = (
    strategyId: string, strategyLabel: string, track: Track,
    results: StockScanResult[], sorts: SortFactorName[],
  ) => {
    // 預先把每筆的 features + metrics 算好
    const enriched = results
      .map((r) => {
        const f = featOf(r);
        const metric = getMetrics(store, r.symbol, date, metricCache);
        return f && metric ? { r, f, metric } : null;
      })
      .filter((x): x is NonNullable<typeof x> => x != null);
    if (enriched.length === 0) return;
    for (const sort of sorts) {
      const fn = SORT_DEFS[sort];
      const sorted = [...enriched]
        .sort((a, b) => fn(b.f) - fn(a.f))
        .map((x) => ({ symbol: x.r.symbol, name: x.r.name, metric: x.metric }));
      pushPicks(acc, { market, engine: 'buymethod', strategyId, strategyLabel, track, sortKey: sort, sortLabel: sort }, date, sorted);
      totalPicks += sorted.length;
    }
  };

  for (const letter of BUY_LETTERS) {
    try {
      if (letter === 'R') {
        const rResults = await scanner.scanDeviationExtreme(stocks, date, 'long', R_TOP_N);
        handle('R', `${nameOf('R')}（R）`, 'mechanical', rResults, R_SORTS);
      } else {
        const results = await scanner.scanBuyMethod(letter, stocks, date);
        const matched = results.filter((r) => (r.matchedMethods?.length ?? 0) > 0);
        handle(letter, `${nameOf(letter)}（${letter}）`, trackOf(letter) as Track, matched, BUY_SORTS);
      }
    } catch (e) {
      console.error(`    [${market} ${date}] 字母 ${letter} ✗ ${e instanceof Error ? e.message : e}`);
    }
  }
  return totalPicks;
}

// ════════════════════════════════════════════════════════════════════════════
// 三色引擎
// ════════════════════════════════════════════════════════════════════════════
interface SanSeScanLike {
  records: ResonanceRecord[];
  results: Record<string, SanSeHit[]>;
}
async function runSanseDay(
  scan: SanSeScanLike,
  market: Market,
  date: string,
  store: Map<string, SymStore>,
  acc: Map<string, Acc>,
  metricCache: Map<string, MetricResult>,
): Promise<number> {
  let total = 0;

  // ── 強度檔位（嚴格/中等/寬鬆）：results[level] = SanSeHit[] ──
  for (const level of ['strict', 'medium', 'loose'] as const) {
    const hits = scan.results[level] ?? [];
    const enriched = hits
      .map((h) => {
        const metric = getMetrics(store, h.symbol, date, metricCache);
        return metric ? { h, metric } : null;
      })
      .filter((x): x is NonNullable<typeof x> => x != null);
    if (enriched.length === 0) continue;
    const tierSorts: { key: string; label: string; fn: (h: SanSeHit) => number }[] = [
      { key: '漲幅', label: '漲幅', fn: (h) => h.changePct },
      { key: '短攻', label: '短攻強度', fn: (h) => h.shortAttack },
      { key: '成交額名次', label: '成交額名次', fn: (h) => -(h.turnoverRank ?? 9999) },
    ];
    for (const s of tierSorts) {
      const sorted = [...enriched]
        .sort((a, b) => s.fn(b.h) - s.fn(a.h))
        .map((x) => ({ symbol: x.h.symbol, name: x.h.name, metric: x.metric }));
      pushPicks(acc, {
        market, engine: 'sanse', strategyId: `tier_${level}`, strategyLabel: TIER_LABEL[level],
        sortKey: s.key, sortLabel: s.label,
      }, date, sorted);
      total += sorted.length;
    }
  }

  // ── 組合桶：records 依 bucketsForRecord 落入多個桶 ──
  const bucketDay = new Map<string, { rec: ResonanceRecord; metric: NonNullable<MetricResult> }[]>();
  for (const rec of scan.records) {
    const metric = getMetrics(store, rec.symbol, date, metricCache);
    if (!metric) continue;
    for (const bkey of bucketsForRecord(rec)) {
      const arr = bucketDay.get(bkey) ?? [];
      arr.push({ rec, metric });
      bucketDay.set(bkey, arr);
    }
  }
  const bucketSorts: { key: string; label: string; fn: (r: ResonanceRecord) => number }[] = [
    { key: '漲幅', label: '漲幅', fn: (r) => r.changePct },
    { key: '共振強度', label: '共振強度', fn: (r) => r.report.groupBuyCount * 100 + r.report.scores.shortAttack },
  ];
  for (const [bkey, arr] of bucketDay) {
    const label = BUCKET_LABEL.get(bkey) ?? bkey;
    for (const s of bucketSorts) {
      const sorted = [...arr]
        .sort((a, b) => s.fn(b.rec) - s.fn(a.rec))
        .map((x) => ({ symbol: x.rec.symbol, name: x.rec.name, metric: x.metric }));
      pushPicks(acc, {
        market, engine: 'sanse', strategyId: `bucket_${bkey}`, strategyLabel: `三色·${label}`,
        sortKey: s.key, sortLabel: s.label,
      }, date, sorted);
      total += sorted.length;
    }
  }
  return total;
}

// ════════════════════════════════════════════════════════════════════════════
// 主流程
// ════════════════════════════════════════════════════════════════════════════
async function runMarket(market: Market, allRows: LeaderboardRow[]): Promise<{ start: string; end: string; days: number }> {
  console.log(`\n══ ${market} ══`);
  const store = loadMarketStore(market);
  const allDays = loadIndexDays(market);
  const usable = allDays.length > FORWARD_TD ? allDays.slice(0, -FORWARD_TD) : allDays;
  // 視窗：預設取 index 行事曆末段 WINDOW_DAYS 天；BACKTEST_START/END 給定則 pin 到固定區間（重現用）。
  const windowDays = (PIN_START || PIN_END)
    ? usable.filter((d) => (!PIN_START || d >= PIN_START) && (!PIN_END || d <= PIN_END))
    : usable.slice(-WINDOW_DAYS);
  console.log(`  視窗 ${windowDays[0]} ~ ${windowDays[windowDays.length - 1]}（${windowDays.length} 交易日；排除尾端 ${FORWARD_TD}${PIN_START || PIN_END ? '；已 pin' : ''}）`);

  const acc = new Map<string, Acc>();
  const doBuy = ENGINE_FILTER === 'both' || ENGINE_FILTER === 'buymethod';
  const doSanse = ENGINE_FILTER === 'both' || ENGINE_FILTER === 'sanse';

  // scanner（買法）
  let scanner: any = null;
  if (doBuy) {
    if (market === 'CN') { const { ChinaScanner } = await import('@/lib/scanner/ChinaScanner'); scanner = new ChinaScanner(); }
    else { const { TaiwanScanner } = await import('@/lib/scanner/TaiwanScanner'); scanner = new TaiwanScanner(); }
  }
  // 三色掃描器
  const sanseScan = doSanse
    ? (market === 'CN'
        ? (await import('@/lib/cn-sanse/scan')).scanSanSe
        : (await import('@/lib/tw-sanse/scan')).scanTwSanSe)
    : null;

  const t0 = Date.now();
  let buyFails = 0, sanseFails = 0;
  for (let di = 0; di < windowDays.length; di++) {
    const date = windowDays[di];
    const metricCache = new Map<string, MetricResult>();
    // 兩引擎各自獨立 try/catch：買法掛了不可連帶吞掉同日三色（反之亦然）。
    if (doBuy && scanner) {
      try {
        warmScannerCache(store, date);   // 預熱：scanPure + 字母全記憶體命中
        await runBuyMethodDay(scanner, market, date, store, acc, metricCache);
      } catch (e) {
        buyFails++;
        console.error(`  [${market} ${date}] 買法 ✗ ${e instanceof Error ? e.message : e}`);
      }
    }
    if (doSanse && sanseScan) {
      try {
        const scan = await sanseScan({ asOfDate: date }) as unknown as SanSeScanLike;
        await runSanseDay(scan, market, date, store, acc, metricCache);
      } catch (e) {
        sanseFails++;
        console.error(`  [${market} ${date}] 三色 ✗ ${e instanceof Error ? e.message : e}`);
      }
    }
    if ((di + 1) % 10 === 0 || di === windowDays.length - 1) {
      const el = (Date.now() - t0) / 1000;
      const perDay = el / (di + 1);
      const eta = perDay * (windowDays.length - di - 1);
      const cs = getScannerCacheStats();
      console.log(`  [${market}] ${di + 1}/${windowDays.length} ${date}  累計 ${acc.size} 列  ${el.toFixed(0)}s (${perDay.toFixed(1)}s/日, ETA ${eta.toFixed(0)}s)  cache ${cs.hitRate}`);
    }
  }

  // 收成列
  for (const a of acc.values()) allRows.push(buildRow(a.meta, a.picks));
  if (buyFails || sanseFails) console.log(`  ⚠ ${market} 失敗天數：買法 ${buyFails}、三色 ${sanseFails}（已分別計、未互相連坐）`);
  return { start: windowDays[0], end: windowDays[windowDays.length - 1], days: windowDays.length };
}

function writeDoc(
  allRows: LeaderboardRow[],
  window: { start: string; end: string; days: number },
  perMarketWindow: LeaderboardDoc['perMarketWindow'],
): { jsonPath: string; mdPath: string } {
  const doc: LeaderboardDoc = {
    generatedAt: new Date().toISOString(),
    entryBaseline: ENTRY_MODE === 'next_close' ? 'next-close(≈13:25)' : 'next-open',
    window: { start: window.start, end: window.end, tradingDays: window.days, label: LABEL, forwardTd: FORWARD_TD },
    perMarketWindow,
    horizons: ['d1', 'd3', 'd5'],
    rows: allRows,
    meta: {
      survivorshipNote: '本地 K 只含現存代號，下市/ST/退市股不在內 → 存活偏差、結論偏樂觀（視窗內停止交易者極少，但歷史下市股完全缺席）。',
      minPicks: MIN_PICKS,
      turnoverTopN: TURNOVER_TOP_N,
      notes: [
        ENTRY_MODE === 'next_close'
          ? '買入基準=隔日收盤（≈朱書 13:25 市價單，日K 最貼近近似；dN 從進場日往後數）；漲停尾盤鎖死買不到 / 跳空>25%(污染) / 停牌扁平根 剔除。'
          : '買入基準=隔日開盤；漲停鎖死買不到 / 隔夜跳空>25%(污染) / 停牌扁平根 的樣本剔除。',
        '候選宇宙=20 日均成交額 top-500（對齊 production TurnoverRank，兩市場同）。',
        '買法字母走 lib/scanner 正規路徑（scanPure/scanBuyMethod/scanDeviationExtreme）。',
        '三色強度檔位=results[strict/medium/loose]；組合桶=bucketsForRecord。',
        '「天數」= 該策略×排序有出 pick 的掃描日數，當頻率參考即可。',
      ],
    },
  };
  fs.mkdirSync(OUT_JSON_DIR, { recursive: true });
  fs.mkdirSync(OUT_MD_DIR, { recursive: true });
  const jsonPath = path.join(OUT_JSON_DIR, `strategy-leaderboard${ENTRY_SUFFIX}.json`);
  fs.writeFileSync(jsonPath, JSON.stringify(doc));
  const today = new Date().toISOString().slice(0, 10);
  const mdPath = path.join(OUT_MD_DIR, `unified-leaderboard${SUFFIX}-${today}.md`);
  fs.writeFileSync(mdPath, buildMarkdown(doc));
  return { jsonPath, mdPath };
}

async function main(): Promise<void> {
  const startedAt = Date.now();
  // 靜音 scanner 的 console.info（每字母每日 "跳過粗掃" 噪音）；保留 warn/error。
  const origInfo = console.info;
  console.info = () => {};
  console.log('\n  ═══ 統一策略排行榜回測 ═══');
  console.log(`  window=${WINDOW_DAYS}d label=${LABEL} forwardTd=${FORWARD_TD} market=${MARKET_FILTER} engine=${ENGINE_FILTER} minPicks=${MIN_PICKS}`);

  const markets: Market[] = MARKET_FILTER === 'TW' ? ['TW'] : MARKET_FILTER === 'CN' ? ['CN'] : ['TW', 'CN'];
  const allRows: LeaderboardRow[] = [];
  const window = { start: '', end: '', days: 0 };
  const perMarketWindow: LeaderboardDoc['perMarketWindow'] = {};
  for (const mkt of markets) {
    const w = await runMarket(mkt, allRows);
    perMarketWindow![mkt] = { start: w.start, end: w.end, tradingDays: w.days };
    // TW 先跑、收完列後 store 隨函式作用域釋放，再跑 CN（壓峰值記憶體）
    if (!window.start) { window.start = w.start; window.end = w.end; window.days = w.days; }
    else { if (w.start < window.start) window.start = w.start; if (w.end > window.end) window.end = w.end; window.days = Math.max(window.days, w.days); }
    const g = (global as { gc?: () => void }).gc;
    if (g) g();
    // 每個市場跑完就落地一次（多小時跑程的崩潰保險）
    const { jsonPath, mdPath } = writeDoc(allRows, window, perMarketWindow);
    console.log(`  ✓ ${mkt} 完成並落地：${path.relative(process.cwd(), jsonPath)}（累計 ${allRows.length} 列）`);
    console.log(`    ${path.relative(process.cwd(), mdPath)}`);
  }

  console.info = origInfo;

  // 終端摘要：各市場 d1 top1 平均 top 5
  for (const mkt of markets) {
    const rows = allRows.filter((r) => r.market === mkt && r.days >= MIN_PICKS).sort((a, b) => b.byHorizon.d1.top1.avgPct - a.byHorizon.d1.top1.avgPct);
    console.log(`\n  ── ${mkt} d1 top1 平均 排行 top 5 ──`);
    rows.slice(0, 5).forEach((r, i) => {
      const b = r.byHorizon.d1;
      console.log(`  ${i + 1}. ${r.strategyLabel} × ${r.sortLabel} | 天數${r.days} | d1=${b.top1.avgPct >= 0 ? '+' : ''}${b.top1.avgPct}% (勝率${b.top1.winRatePct}%) | cohort ${b.cohort.avgPct >= 0 ? '+' : ''}${b.cohort.avgPct}%`);
    });
  }
  console.log(`\n  完成（${((Date.now() - startedAt) / 1000).toFixed(0)}s）\n`);
}

main().catch((e) => { console.error(e); process.exit(1); });
