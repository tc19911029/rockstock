/**
 * 賣出訊號「輕重」回測 — 把每個賣訊當「離散事件」，逐根回放全市場歷史，
 * 量「訊號日收盤後 d1/d3/d5/d10/d20 報酬 + 窗內最大回落」，扣掉「同日同儕宇宙平均」(alpha)
 * 控制行情，排出「最重 → 最輕」。純測量，不改任何生產選股/賣出/通知邏輯。
 *
 * 兩大訊號家族、一套 forward 量測（以訊號日收盤為基準）：
 *   book ：lib/analysis/sellSignals.ts 的 detectSellSignals（21 種，含手寫嚴重度，受測）
 *   sanse：三色該賣（computeDualB/computeXys 的死叉/跌破 + computeSanSe 的主力轉弱事件）
 *   combo：同根多訊號衍生組合
 *
 * 效能：每檔 computeIndicators / computeDualB / computeXys / computeSanSe 各算「一次」
 *       （指標因果、向量化 O(n)），再逐根索引；只處理「曾進過某日成交額 top-N 宇宙」的股。
 *       同儕基準在同一 pass 累積（每個宇宙成員的 forward 報酬都入 cohort）。
 *
 * 用法：
 *   MARKET=both BACKTEST_WINDOW_DAYS=480 BACKTEST_LABEL=2y \
 *   NODE_OPTIONS="--max-old-space-size=12288" \
 *   npx tsx scripts/backtest-sell-heaviness.ts
 *
 *   快速計時探針：MARKET=TW BACKTEST_WINDOW_DAYS=20 npx tsx scripts/backtest-sell-heaviness.ts
 */

import fs from 'fs';
import path from 'path';
import { computeIndicators } from '@/lib/indicators';
import type { CandleWithIndicators } from '@/types';
import { detectSellSignals } from '@/lib/analysis/sellSignals';
import { computeDualB, computeXys } from '@/lib/cn-sanse/dualB';
import { computeSanSe } from '@/lib/cn-sanse/selectors';
import { sellMetricsFromLocalCandles } from '@/lib/backtest/sellForwardMetrics';
import {
  inHoldableContext, isVolSuspect, CohortAccumulator, CoOccurrenceAccumulator,
  buildSignalStats, buildSellHeavinessMarkdown,
  SANSE_SELL_DEFS, COMBO_DEFS, SELL_CFG,
  type FiringRecord, type SignalMeta,
} from '@/lib/backtest/sellHeaviness';
import type { Market, SignalStat, SellHeavinessDoc } from '@/lib/backtest/sellHeavinessTypes';

// ── Config ───────────────────────────────────────────────────────────────────
const WINDOW_DAYS = parseInt(process.env.BACKTEST_WINDOW_DAYS ?? '480', 10) || 480;
const LABEL = process.env.BACKTEST_LABEL ?? '2y';
const FORWARD_TD = parseInt(process.env.FORWARD_TD ?? '32', 10) || 32;
const MARKET_FILTER = (process.env.MARKET ?? 'both').toUpperCase();
const TURNOVER_TOP_N: Record<Market, number> = { TW: 500, CN: 800 };
const INDEX_SYMBOL: Record<Market, string> = { TW: '^TWII', CN: '000001.SS' };
const INDEX_SYMBOL_SZ = '399001.SZ';

const ROOT = path.join(process.cwd(), 'data');
const CANDLE_ROOT = path.join(ROOT, 'candles');
const OUT_JSON_DIR = path.join(ROOT, 'backtest');
const OUT_MD_DIR = path.join(ROOT, 'backtest-output');
const SUFFIX = LABEL ? `-${LABEL}` : '';

interface SymStore {
  symbol: string;
  name: string;
  c: CandleWithIndicators[];
  dateToIdx: Map<string, number>;
}

// 指數代號排除（000001.SZ=平安銀行個股不可排除；指數是 000001.SS / 000300.SS / 399001.SZ）。
const isIndexSym = (s: string) =>
  s.startsWith('^') || s === '000001.SS' || s === '000300.SS' || s === '399001.SZ';

function loadMarketStore(market: Market): Map<string, SymStore> {
  const dir = path.join(CANDLE_ROOT, market);
  const store = new Map<string, SymStore>();
  if (!fs.existsSync(dir)) return store;
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
  process.stdout.write(`  讀 ${market} L1`);
  let n = 0;
  for (const f of files) {
    const symbol = f.replace('.json', '');
    if (isIndexSym(symbol)) continue;
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

/** 讀指數 K 的 date→close map（給 m_weak 的相對強弱對齊用）。 */
function loadIndexCloseMap(market: Market, symbol: string): Map<string, number> {
  const file = path.join(CANDLE_ROOT, market, `${symbol}.json`);
  const map = new Map<string, number>();
  if (!fs.existsSync(file)) return map;
  const raw = JSON.parse(fs.readFileSync(file, 'utf-8'));
  const candles = Array.isArray(raw) ? raw : raw.candles ?? [];
  for (const c of candles) map.set(String(c.date).slice(0, 10), Number(c.close) || NaN);
  return map;
}

function loadIndexDays(market: Market): string[] {
  const file = path.join(CANDLE_ROOT, market, `${INDEX_SYMBOL[market]}.json`);
  if (!fs.existsSync(file)) throw new Error(`找不到指數 K：${file}`);
  const raw = JSON.parse(fs.readFileSync(file, 'utf-8'));
  const candles = Array.isArray(raw) ? raw : raw.candles ?? [];
  return candles.map((c: { date: string }) => String(c.date).slice(0, 10)).sort();
}

/** 某掃描日成交額 top-N 的代號集合。 */
function turnoverTopNSet(store: Map<string, SymStore>, date: string, topN: number): Set<string> {
  const list: { symbol: string; turnover: number }[] = [];
  for (const s of store.values()) {
    const idx = s.dateToIdx.get(date);
    if (idx == null) continue;
    const bar = s.c[idx];
    if (bar.close > 0 && bar.volume > 0) list.push({ symbol: s.symbol, turnover: bar.close * bar.volume });
  }
  list.sort((a, b) => b.turnover - a.turnover);
  return new Set(list.slice(0, topN).map((x) => x.symbol));
}

/** 把指數 close map 前向填補成與 candles 等長的陣列。 */
function alignIndexClose(candles: CandleWithIndicators[], idxMap: Map<string, number>): number[] {
  let last = NaN;
  return candles.map((c) => {
    const v = idxMap.get(c.date.slice(0, 10));
    if (v != null && Number.isFinite(v)) last = v;
    return last;
  });
}

function runMarket(market: Market, allSignals: SignalStat[], coOut: Record<string, Record<string, Record<string, number>>>): { start: string; end: string; days: number } {
  console.log(`\n══ ${market} ══`);
  const store = loadMarketStore(market);
  const allDays = loadIndexDays(market);
  const usable = allDays.length > FORWARD_TD ? allDays.slice(0, -FORWARD_TD) : allDays;
  const windowDays = usable.slice(-WINDOW_DAYS);
  const windowSet = new Set(windowDays);
  console.log(`  視窗 ${windowDays[0]} ~ ${windowDays[windowDays.length - 1]}（${windowDays.length} 交易日；排除尾端 ${FORWARD_TD}）`);

  // 指數 close map（m_weak 用）
  const idxMapSH = loadIndexCloseMap(market, INDEX_SYMBOL[market]);
  const idxMapSZ = market === 'CN' ? loadIndexCloseMap(market, INDEX_SYMBOL_SZ) : idxMapSH;
  const idxMapSZeff = idxMapSZ.size > 0 ? idxMapSZ : idxMapSH;

  // Pass A：每日宇宙成員 + union
  const universeByDate = new Map<string, Set<string>>();
  const universeSymbols = new Set<string>();
  for (const d of windowDays) {
    const set = turnoverTopNSet(store, d, TURNOVER_TOP_N[market]);
    universeByDate.set(d, set);
    for (const s of set) universeSymbols.add(s);
  }
  console.log(`  union 宇宙 ${universeSymbols.size} 支（曾進過某日 top-${TURNOVER_TOP_N[market]}）`);

  // Pass B：逐檔三色 + 書本 firing + 同儕累積
  const cohort = new CohortAccumulator();
  const coAccum = new CoOccurrenceAccumulator();
  const firingsByType = new Map<string, FiringRecord[]>();
  const metaByType = new Map<string, SignalMeta>();
  const pushFiring = (rec: FiringRecord) => {
    let arr = firingsByType.get(rec.signalType);
    if (!arr) { arr = []; firingsByType.set(rec.signalType, arr); }
    arr.push(rec);
    if (!metaByType.has(rec.signalType)) {
      metaByType.set(rec.signalType, { signalType: rec.signalType, label: rec.label, family: rec.family, declaredSeverity: rec.declaredSeverity });
    }
  };
  const sanseLabel = new Map(SANSE_SELL_DEFS.map((d) => [d.id, d.label]));

  let nanIdxInWindow = 0;
  let totalInWindow = 0;
  let processed = 0;
  const t0 = Date.now();

  for (const symbol of universeSymbols) {
    const s = store.get(symbol);
    if (!s) continue;
    const idxMap = symbol.endsWith('.SZ') ? idxMapSZeff : idxMapSH;
    const indexClose = alignIndexClose(s.c, idxMap);
    const db = computeDualB(s.c);
    const xys = computeXys(s.c);
    const series = computeSanSe(s.c, indexClose);
    const ms = series.midStrength;

    for (let i = 0; i < s.c.length; i++) {
      const d = s.c[i].date.slice(0, 10);
      if (!windowSet.has(d)) continue;
      if (!universeByDate.get(d)?.has(symbol)) continue;
      totalInWindow++;
      if (!Number.isFinite(indexClose[i])) nanIdxInWindow++;

      const res = sellMetricsFromLocalCandles(s.c, i);
      if (!res) continue;
      if (res.suspect) continue;              // 停牌缺口 → 整根移出主統計（含 cohort）
      // 持股情境用「訊號前一根」(i-1)：賣訊本身常讓 ma5<ma20 / close<ma20（死叉、跌破月線），
      // 在訊號根判情境會把這些最關鍵的「趨勢破壞」訊號全部排除。i-1 = 持股者進入訊號時的狀態。
      // firing 與 cohort 共用同一個 ctx → uptrend 子集定義一致（昨在多頭、今訊號、由今收盤往前量）。
      const ctx = inHoldableContext(s.c, i - 1);

      // 同儕累積（每個宇宙成員都入，與是否觸發無關）
      cohort.add(d, 'all', res.m);
      if (ctx) cohort.add(d, 'uptrend', res.m);

      const volSuspect = isVolSuspect(s.c, i);
      const firedAtomic = new Set<string>();
      let highCount = 0;

      // book firing
      const book = detectSellSignals(s.c, i);
      for (const sig of book) {
        firedAtomic.add(sig.type);
        if (sig.severity === 'high') highCount++;
        pushFiring({
          signalType: sig.type, label: sig.label, family: 'book', declaredSeverity: sig.severity,
          market, date: d, symbol, name: s.name, base: res.base, inContext: ctx, volSuspect, suspect: false, m: res.m,
        });
      }

      // sanse firing（事件化）
      const sanseFired: string[] = [];
      if (db.deadCross[i]) sanseFired.push('b_dead');
      if (db.breakDn[i]) sanseFired.push('b_breakdn');
      if (db.deadCross[i] && db.breakDn[i]) sanseFired.push('b_sresonance');
      if (xys.deadCross[i]) sanseFired.push('c_dead');
      if (i >= 1 && Number.isFinite(ms[i]) && Number.isFinite(ms[i - 1]) && ms[i] < 0 && ms[i - 1] >= 0) sanseFired.push('m_weak');
      for (const id of sanseFired) {
        if (id !== 'b_sresonance') firedAtomic.add(id); // b_sresonance 是衍生，不入共現
        pushFiring({
          signalType: id, label: sanseLabel.get(id) ?? id, family: 'sanse', declaredSeverity: null,
          market, date: d, symbol, name: s.name, base: res.base, inContext: ctx, volSuspect, suspect: false, m: res.m,
        });
      }

      // combo firing
      for (const combo of COMBO_DEFS) {
        if (combo.pred(firedAtomic, highCount)) {
          pushFiring({
            signalType: combo.id, label: combo.label, family: 'combo', declaredSeverity: null,
            market, date: d, symbol, name: s.name, base: res.base, inContext: ctx, volSuspect, suspect: false, m: res.m,
          });
        }
      }

      // 共現（atomic book + sanse）
      if (firedAtomic.size > 0) coAccum.add([...firedAtomic]);
    }

    if (++processed % 300 === 0) {
      const el = (Date.now() - t0) / 1000;
      console.log(`  [${market}] ${processed}/${universeSymbols.size} 檔  ${el.toFixed(0)}s  訊號型別 ${firingsByType.size}`);
    }
  }

  // m_weak NaN-index 守衛
  const nanRate = totalInWindow ? nanIdxInWindow / totalInWindow : 0;
  console.log(`  指數對齊 NaN 率 ${(nanRate * 100).toFixed(2)}%（in-window ${totalInWindow} 根）`);
  if (nanRate > 0.05) throw new Error(`${market} 指數對齊 NaN 率 ${(nanRate * 100).toFixed(1)}% > 5% — 疑指數 K 缺檔，m_weak 不可信，中止`);

  const stats = buildSignalStats(market, firingsByType, metaByType, cohort);
  for (const st of stats) allSignals.push(st);
  coOut[market] = coAccum.finalize();
  const firingTotal = [...firingsByType.values()].reduce((a, b) => a + b.length, 0);
  console.log(`  ✓ ${market}：${firingsByType.size} 訊號型別、${firingTotal} firing、${stats.length} 統計列`);
  return { start: windowDays[0], end: windowDays[windowDays.length - 1], days: windowDays.length };
}

function writeDoc(
  allSignals: SignalStat[],
  coOccurrence: Record<string, Record<string, Record<string, number>>>,
  window: { start: string; end: string; days: number },
): { jsonPath: string; mdPath: string } {
  const doc: SellHeavinessDoc = {
    generatedAt: new Date().toISOString(),
    entryBaseline: 'signal-close',
    window: { start: window.start, end: window.end, tradingDays: window.days, label: LABEL, forwardTd: FORWARD_TD },
    horizons: ['d1', 'd3', 'd5', 'd10', 'd20'],
    signals: allSignals,
    coOccurrence: coOccurrence as SellHeavinessDoc['coOccurrence'],
    meta: {
      survivorshipNote: '本地 K 只含現存代號，下市/退市的最慘案例缺席 → 賣訊輕重被「低估」（真實可能更重，強化「該立刻動作」）。',
      minFirings: SELL_CFG.MIN_FIRINGS,
      shrinkK: SELL_CFG.SHRINK_K,
      cohortMinN: SELL_CFG.COHORT_MIN_N,
      holdableContext: { upThr: SELL_CFG.holdable.upThr, lookbackN: SELL_CFG.holdable.lookbackN },
      heavinessWeights: { ...SELL_CFG.weights },
      notes: [
        '量測基準＝訊號日收盤；alpha＝訊號 − 同日同儕宇宙平均（同情境）；越負＝越重。',
        'book 走 lib/analysis/sellSignals.ts 的 detectSellSignals（手寫 severity 受測）；sanse 走 computeDualB/computeXys/computeSanSe；不改任何生產邏輯。',
        'm_weak＝主力中線強勢首次下穿 0 的「研究事件」，非 ntfy 實推訊號（生產刻意排除持續狀態）。',
        '量門控訊號（爆量長上影/連2爆量3黑/急漲長黑）對 L1 量單位污染敏感，volSuspectShare 揭露受影響比例。',
        '台股 m_weak 信心較低（三色源自陸股、相對強弱對齊 ^TWII）。',
        '停牌缺口（forward 視窗內 >7 日曆天）的樣本已整根移出主統計。',
      ],
    },
  };
  fs.mkdirSync(OUT_JSON_DIR, { recursive: true });
  fs.mkdirSync(OUT_MD_DIR, { recursive: true });
  const jsonPath = path.join(OUT_JSON_DIR, 'sell-heaviness.json');
  fs.writeFileSync(jsonPath, JSON.stringify(doc));
  const today = new Date().toISOString().slice(0, 10);
  const mdPath = path.join(OUT_MD_DIR, `sell-heaviness${SUFFIX}-${today}.md`);
  fs.writeFileSync(mdPath, buildSellHeavinessMarkdown(doc));
  return { jsonPath, mdPath };
}

function main(): void {
  const startedAt = Date.now();
  const origInfo = console.info;
  console.info = () => {};
  console.log('\n  ═══ 賣出訊號輕重回測 ═══');
  console.log(`  window=${WINDOW_DAYS}d label=${LABEL} forwardTd=${FORWARD_TD} market=${MARKET_FILTER} minFirings=${SELL_CFG.MIN_FIRINGS}`);

  const markets: Market[] = MARKET_FILTER === 'TW' ? ['TW'] : MARKET_FILTER === 'CN' ? ['CN'] : ['TW', 'CN'];
  const allSignals: SignalStat[] = [];
  const coOccurrence: Record<string, Record<string, Record<string, number>>> = {};
  const window = { start: '', end: '', days: 0 };
  for (const mkt of markets) {
    const w = runMarket(mkt, allSignals, coOccurrence);
    if (!window.start) { window.start = w.start; window.end = w.end; window.days = w.days; }
    else { if (w.start < window.start) window.start = w.start; if (w.end > window.end) window.end = w.end; window.days = Math.max(window.days, w.days); }
    const g = (global as { gc?: () => void }).gc;
    if (g) g();
    const { jsonPath, mdPath } = writeDoc(allSignals, coOccurrence, window);
    console.log(`  ✓ ${mkt} 落地：${path.relative(process.cwd(), jsonPath)}`);
    console.log(`    ${path.relative(process.cwd(), mdPath)}`);
  }

  console.info = origInfo;

  // 終端摘要：各市場「持股情境」最重 5 訊號
  for (const mkt of markets) {
    const rows = allSignals
      .filter((s) => s.market === mkt && s.scope === 'uptrend' && !s.underpowered)
      .sort((a, b) => a.alphaD5Shrunk - b.alphaD5Shrunk);
    console.log(`\n  ── ${mkt} 最重 5 賣訊（持股情境，依 alphaD5 收斂）──`);
    rows.slice(0, 5).forEach((r, i) => {
      console.log(`  ${i + 1}. ${r.label} | 觸發${r.firings} | alphaD5=${r.alphaD5Shrunk >= 0 ? '+' : ''}${r.alphaD5Shrunk} | d5=${r.byHorizon.d5.avgRetPct >= 0 ? '+' : ''}${r.byHorizon.d5.avgRetPct}% (同儕${r.byHorizon.d5.cohortAvgPct >= 0 ? '+' : ''}${r.byHorizon.d5.cohortAvgPct}%) | 最大回落${r.avgMaxDrawdownPct}% | ${r.declaredSeverity ? `手寫${r.declaredSeverity}/${r.severityVerdict}` : r.family}`);
    });
  }
  console.log(`\n  完成（${((Date.now() - startedAt) / 1000).toFixed(0)}s）\n`);
}

main();
