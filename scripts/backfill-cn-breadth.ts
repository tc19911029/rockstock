/**
 * 陸股漲停池 + 市場寬度 + 情緒週期 歷史回填（cn-agents P1）
 *
 * 用法：
 *   npx tsx scripts/backfill-cn-breadth.ts --from 2024-06-01 [--to YYYY-MM-DD] [--force]
 *                                          [--growth-limit N]
 *
 * 兩遍式（Pass 1 抓取/重建固化 → Pass 2 組裝重放）：
 *   Pass 1 分流（2026-06-12 改 — EM push2ex 漲停池 date 參數實測只保留 ~8 個
 *   交易日，2026-05-20 起全空；akshare 同源同窗口已驗證一樣空）：
 *     - date 在 EM 窗口內（最後已收盤交易日往回 EM_POOL_WINDOW_TDAYS 個交易日）
 *       → 沿用 fetchPools(date) + fetchYesterdayPoolPerformance(date)
 *         （封單額/封板時間/炸板次數等盤中欄位只有這條路拿得到）
 *     - 更舊 → 日K 重建路（lib/cn-agents/backfillPools.ts reconstructPools）：
 *       主板 3018 檔讀 L1（data/candles/CN/{symbol}.json）、創業/科創 ~2050 檔
 *       讀 EM 日K 快取（data/cn-agents/_klines-cache/，逐檔抓一次永久重用）、
 *       北交所不在 universe。一次重建全窗 → 逐日 buildLimitUpPoolDay，
 *       source='candles-backfill'；upCount/downCount/flatCount 用重建值（真實
 *       家數，不再是 0）；昨日漲停/炸板今日表現用 reconstructPools 回的
 *       yestLimitUpReturns / yestBrokenReturns 平均。
 *     兩市成交額（兩路共用）：EM 指數日K（1.000001 + 0.399001）amount 欄相加
 *     （與線上 cnMarketBreadth ulist f6 同源同口徑）；shIndexPct 以 L1 上證 K
 *     相鄰收盤自算為主、EM 指數 K 補缺。
 *   Pass 2：掃 data/cn-agents/limitup-pool/ 全部 date ≤ --to 的日檔（含本次範圍外的
 *     既存檔，讓狀態機 prev 鏈吃最長歷史）→ 按序 buildMarketBreadthDay →
 *     classifyEmotionCycle 全序列（與線上同一個 import — parity 鐵則）→
 *     逐日 saveBreadthDay + 直接重寫 breadth/index.json（最後 BREADTH_INDEX_MAX_DAYS 日）。
 *
 * 續跑：data/cn-agents/_backfill-manifest.json 記 done/failed，中斷重跑自動跳過已完成日、
 * 重試失敗日（既有 failed 裡 EM 窗外的舊日期重跑時自動改走重建路）；--force 無視
 * manifest 與既存檔全部重抓。EM 請求間 400ms 節流（fetchPools 內部三池間另有 250ms），
 * 每 20 日 log 進度。
 *
 * ⚠️ 陷阱備忘：
 *   - 昨日炸板股今日平均（虧錢效應，EM 窗內路徑）從 L1 個股 K 自算：裸碼 6 開頭 →
 *     {sym}.SS.json、0/3 開頭 → {sym}.SZ.json（000001 裸碼按此規則對到平安銀行 .SZ，
 *     不會撞上證指數 — 撞庫教訓見 MEMORY cn_000001_index_stock_collision）；
 *     北交所(4/8/92)與不在 L1 的股自然跳過，整池對到 0 檔 → null（不可回 0）。
 *   - 漲停池 0 檔守門：A 股交易日不可能 0 漲停 — 0 檔多半是「假日表把休市日誤判成
 *     交易日」或上游退化（重建路 0 檔 = 該日全 universe 日K 缺漏），記 failed 不落地。
 *   - 邊界日語意：重建路與 EM 路交界處，promotion 率比對的是不同 source 的
 *     consecBoards（重建=序列內連續漲停日計數 vs EM lbc 欄）— 語意一致
 *     （皆為「連續漲停日數、首板=1」）可直接相接；唯重建對停牌跳日按「該股自身
 *     相鄰兩根」算連續，與 EM 罕見的「N天M板」斷板重計 quirk 可能在個股級差 1，
 *     統計級（晉級率分母數十檔）影響可忽略。
 *   - --growth-limit N：測速用 — 創業/科創只抓前 N 檔 K 線；快取缺檔的成長板股
 *     loadSeries 回 null 自動跳過（cm20 漲停數會低估，會印醒目警告）。
 *     主線全量跑「不要」帶這個參數。
 *   - 本腳本只在本機跑（dual-storage 的 FS 路徑）；Vercel Blob 端由線上 cron 寫。
 *   - 預設 --to = getLastTradingDay('CN')（盤中跑不會把今日進行中的半天資料封進池）。
 */
import { config } from 'dotenv';
import { existsSync } from 'fs';
if (existsSync('.env.local')) config({ path: '.env.local' });
config();

import { promises as fs } from 'fs';
import { readFileSync } from 'fs';
import path from 'path';
import { isTradingDay } from '@/lib/utils/tradingDay';
import { getLastTradingDay } from '@/lib/datasource/marketHours';
import { atomicFsPut } from '@/lib/storage/atomicFsPut';
import { fetchPools, fetchYesterdayPoolPerformance } from '@/lib/cn-agents/datasource/emLimitUpPool';
import {
  fetchEmDailyBars,
  fetchTencentDailyBars,
  fetchGrowthBoardSymbols,
  fetchShSzTurnoverMap,
  cnSymbolToSecid,
  type EmDailyBar,
} from '@/lib/cn-agents/datasource/emDailyKlines';
import { reconstructPools, type BackfillSeriesBar, type BackfillSymbolMeta } from '@/lib/cn-agents/backfillPools';
import {
  buildLimitUpPoolDay,
  buildMarketBreadthDay,
  computeBrokenAvgPctFromQuotes,
} from '@/lib/cn-agents/breadth';
import { classifyEmotionCycle } from '@/lib/cn-agents/cycle';
import { readLimitUpPoolDay, saveLimitUpPoolDay, saveBreadthDay } from '@/lib/cn-agents/storage';
import {
  BREADTH_INDEX_MAX_DAYS,
  CN_AGENTS_SCHEMA_VERSION,
  CYCLE_RULES_VERSION,
} from '@/lib/cn-agents/types';
import type {
  BreadthIndexFile,
  LimitUpPoolDay,
  MarketBreadthDay,
  MarketOverview,
} from '@/lib/cn-agents/types';

const THROTTLE_MS = 400;
const PROGRESS_EVERY = 20;
const CANDLE_DIR = path.join(process.cwd(), 'data', 'candles', 'CN');
const MANIFEST_PATH = path.join(process.cwd(), 'data', 'cn-agents', '_backfill-manifest.json');
const BREADTH_INDEX_PATH = path.join(process.cwd(), 'data', 'cn-agents', 'breadth', 'index.json');
/** EM push2ex 漲停池 date 參數實測保留 ~8 個交易日 → 窗口取 7（留 1 日 buffer） */
const EM_POOL_WINDOW_TDAYS = 7;
const STOCKLIST_PATH = path.join(process.cwd(), 'data', 'cn_stocklist.json');
const META_DIR = path.join(process.cwd(), 'data', 'cn-agents', '_backfill-meta');
const GROWTH_META_PATH = path.join(META_DIR, 'growth-boards.json');
const GROWTH_META_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 天
const KLINES_CACHE_DIR = path.join(process.cwd(), 'data', 'cn-agents', '_klines-cache');
/** 重建需要 from 之前的 prevClose + 連板 lead-in → K 線窗往前推 30 個日曆日 */
const RECON_LEADIN_DAYS = 30;
/** 個股日漲跌幅快取上限（炸板股回查 L1 用；爆了直接清空重來，避免長回填吃光記憶體） */
const PCT_CACHE_MAX_SYMBOLS = 800;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// ── args ─────────────────────────────────────────────────────────────────────

interface Args {
  from: string;
  to: string;
  force: boolean;
  /** 創業/科創 K 線只抓前 N 檔（測速用；主線全量跑不要帶） */
  growthLimit: number | null;
  /** 主板也抓 EM 前復權 K 線進快取（除息日漏抓修正，makeLoadSeries 檔頭說明） */
  emMainboard: boolean;
}

function usage(exitCode: number): never {
  console.log(`陸股漲停池 + 市場寬度 + 情緒週期 歷史回填

用法：
  npx tsx scripts/backfill-cn-breadth.ts --from 2024-06-01 [--to YYYY-MM-DD] [--force] [--growth-limit N]

參數：
  --from YYYY-MM-DD   回填起日（必填）
  --to   YYYY-MM-DD   回填迄日（預設＝最後一個已收盤 CN 交易日）
  --force             無視 manifest 與既存日檔全部重抓
  --growth-limit N    創業/科創 K 線只抓前 N 檔（測速用，cm20 統計會低估）
  --em-mainboard      主板也抓 EM 前復權 K 線（修 L1 除息日接合漏抓；一次性 ~50min）
  --help              印本說明

進度記在 data/cn-agents/_backfill-manifest.json，中斷可續跑（自動跳過已完成日）。
EM 窗外（最後收盤日往回 ${EM_POOL_WINDOW_TDAYS} 個交易日以前）的日期走日K 重建路（source=candles-backfill）。`);
  process.exit(exitCode);
}

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  let from: string | null = null;
  let to: string | null = null;
  let force = false;
  let growthLimit: number | null = null;
  let emMainboard = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') usage(0);
    else if (a === '--force') force = true;
    else if (a === '--em-mainboard') emMainboard = true;
    else if (a === '--from' && argv[i + 1]) { from = argv[++i]; }
    else if (a === '--to' && argv[i + 1]) { to = argv[++i]; }
    else if (a === '--growth-limit' && argv[i + 1]) {
      growthLimit = parseInt(argv[++i], 10);
      if (!Number.isFinite(growthLimit) || growthLimit <= 0) { console.error('❌ --growth-limit 要正整數'); usage(1); }
    }
    else { console.error(`❌ 不認識的參數：${a}`); usage(1); }
  }
  const isYmd = (s: string | null): s is string => !!s && /^\d{4}-\d{2}-\d{2}$/.test(s);
  if (!isYmd(from)) { console.error('❌ --from 必填且須為 YYYY-MM-DD'); usage(1); }
  const lastSealed = getLastTradingDay('CN');
  if (to === null) to = lastSealed;
  if (!isYmd(to)) { console.error('❌ --to 須為 YYYY-MM-DD'); usage(1); }
  // 鐵則 #1 同款精神：只回填「已收盤」的交易日，今日進行中不封
  if (to > lastSealed) {
    console.log(`ℹ️ --to ${to} 超過最後已收盤交易日，夾回 ${lastSealed}`);
    to = lastSealed;
  }
  if (from > to) { console.error(`❌ --from ${from} > --to ${to}`); process.exit(1); }
  return { from, to, force, growthLimit, emMainboard };
}

// ── 交易日工具 ────────────────────────────────────────────────────────────────

function cnTradingDaysInclusive(from: string, to: string): string[] {
  const out: string[] = [];
  const cur = new Date(from + 'T12:00:00');
  const end = new Date(to + 'T12:00:00');
  while (cur <= end) {
    const ds = cur.toISOString().split('T')[0];
    if (isTradingDay(ds, 'CN')) out.push(ds);
    cur.setDate(cur.getDate() + 1);
  }
  return out;
}

function prevCnTradingDay(date: string): string {
  const cur = new Date(date + 'T12:00:00');
  for (;;) {
    cur.setDate(cur.getDate() - 1);
    const ds = cur.toISOString().split('T')[0];
    if (isTradingDay(ds, 'CN')) return ds;
  }
}

/** 含 anchor 往回數第 n 個 CN 交易日（n=1 → anchor 自己；anchor 須為交易日） */
function nthLastCnTradingDay(anchor: string, n: number): string {
  let d = anchor;
  for (let i = 1; i < n; i++) d = prevCnTradingDay(d);
  return d;
}

/** YYYY-MM-DD 往前 n 個日曆日 */
function minusCalendarDays(date: string, n: number): string {
  const d = new Date(date + 'T12:00:00');
  d.setDate(d.getDate() - n);
  return d.toISOString().split('T')[0];
}

const toYmd8 = (date: string): string => date.replace(/-/g, '');

// ── 日K 重建路：universe metas + K 線快取 + loadSeries ───────────────────────

/** 主板 universe（data/cn_stocklist.json，3018 檔，不含創業/科創/北交） */
function loadMainBoardMetas(): BackfillSymbolMeta[] {
  const j = JSON.parse(readFileSync(STOCKLIST_PATH, 'utf-8')) as {
    stocks?: Array<{ symbol: string; name: string; industry?: string | null }>;
  };
  return (j.stocks ?? []).map((s) => ({
    symbol: s.symbol,
    name: s.name,
    industry: s.industry ?? null,
  }));
}

interface GrowthMetaFile {
  fetchedAt: string;
  chiNext: BackfillSymbolMeta[];
  star: BackfillSymbolMeta[];
}

/** 創業/科創代號清單（EM clist；7 天 TTL 快取到 _backfill-meta/growth-boards.json） */
async function loadGrowthBoardMetas(): Promise<BackfillSymbolMeta[]> {
  try {
    const raw = await fs.readFile(GROWTH_META_PATH, 'utf-8');
    const j = JSON.parse(raw) as GrowthMetaFile;
    const age = Date.now() - new Date(j.fetchedAt).getTime();
    if (age < GROWTH_META_TTL_MS && j.chiNext?.length > 0 && j.star?.length > 0) {
      return [...j.chiNext, ...j.star];
    }
  } catch { /* 不存在/壞檔 → 重抓 */ }
  console.log('  📡 抓創業板 + 科創板代號清單（EM clist，翻頁）…');
  const { chiNext, star } = await fetchGrowthBoardSymbols();
  const file: GrowthMetaFile = { fetchedAt: new Date().toISOString(), chiNext, star };
  await fs.mkdir(META_DIR, { recursive: true });
  await atomicFsPut(GROWTH_META_PATH, JSON.stringify(file));
  console.log(`  ✅ 創業板 ${chiNext.length} 檔 + 科創板 ${star.length} 檔（快取 7 天）`);
  return [...chiNext, ...star];
}

interface KlinesCacheFile {
  symbol: string;
  fetchedAt: string;
  /** 抓取窗口（YYYYMMDD）— 命中條件：cached 窗完整涵蓋需求窗 */
  begYmd8: string;
  endYmd8: string;
  bars: EmDailyBar[];
}

/** EM K 線單檔抓取重試（EM 偶發成批 TLS reset / 限流，實測隔 1.5-4s 再打就過） */
const KLINE_FETCH_RETRIES = 2;
const KLINE_RETRY_DELAYS_MS = [1500, 4000];

/**
 * 確保 EM 日K 快取涵蓋 [begYmd8, endYmd8]（創業/科創必走；--em-mainboard 時主板也走）。
 * 逐檔抓（400ms 節流 + 失敗退避重試）、每檔抓完立即落盤（中斷可續跑，重跑命中
 * 快取不重抓）；窗口不夠時抓「舊窗 ∪ 新窗」聯集重寫（EM 一次回整段，成本相同）。
 * 回傳測速統計（給主線全量跑前估時）。
 */
async function ensureEmKlinesCache(
  metas: BackfillSymbolMeta[],
  begYmd8: string,
  endYmd8: string,
): Promise<{ fetched: number; cachedHit: number; failed: number; avgFetchMs: number }> {
  await fs.mkdir(KLINES_CACHE_DIR, { recursive: true });
  let fetched = 0;
  let cachedHit = 0;
  let failed = 0;
  let totalMs = 0;
  for (let i = 0; i < metas.length; i++) {
    const meta = metas[i];
    const cachePath = path.join(KLINES_CACHE_DIR, `${meta.symbol}.json`);
    let existing: KlinesCacheFile | null = null;
    try {
      existing = JSON.parse(await fs.readFile(cachePath, 'utf-8')) as KlinesCacheFile;
    } catch { /* miss */ }
    if (existing && existing.begYmd8 <= begYmd8 && existing.endYmd8 >= endYmd8) {
      cachedHit++;
    } else {
      const beg = existing && existing.begYmd8 < begYmd8 ? existing.begYmd8 : begYmd8;
      const end = existing && existing.endYmd8 > endYmd8 ? existing.endYmd8 : endYmd8;
      let ok = false;
      for (let attempt = 0; attempt <= KLINE_FETCH_RETRIES && !ok; attempt++) {
        try {
          if (attempt > 0) await sleep(KLINE_RETRY_DELAYS_MS[attempt - 1]);
          else if (fetched > 0) await sleep(THROTTLE_MS);
          const t0 = Date.now();
          // 批量逐檔抓 Tencent qfq 為主（push2his 對批量轟炸會整批 TLS reset，
          // 連代理出口都封 — 2026-06-12 實測 75/100 失敗）；Tencent 掛才退 EM。
          // 兩者皆前復權自洽序列，漲停判定語意相同（見 emDailyKlines 檔頭）。
          let bars: EmDailyBar[];
          try {
            bars = await fetchTencentDailyBars(meta.symbol, beg, end);
          } catch {
            bars = await fetchEmDailyBars(cnSymbolToSecid(meta.symbol), beg, end);
          }
          if (bars.length === 0) {
            // Tencent 回空可能是真空（新股上市前）也可能是回應形狀漂移 —
            // 快取空檔前先用 EM 交叉確認一次，EM 也空/掛才信任空值
            try {
              bars = await fetchEmDailyBars(cnSymbolToSecid(meta.symbol), beg, end);
            } catch { /* 兩源皆無 → 視為真空 */ }
          }
          totalMs += Date.now() - t0;
          // 空 bars 也快取（新股上市前真空），避免每次重跑都白打一發
          const file: KlinesCacheFile = {
            symbol: meta.symbol,
            fetchedAt: new Date().toISOString(),
            begYmd8: beg,
            endYmd8: end,
            bars,
          };
          await atomicFsPut(cachePath, JSON.stringify(file));
          fetched++;
          ok = true;
        } catch (err) {
          if (attempt === KLINE_FETCH_RETRIES) {
            failed++;
            if (failed <= 5) {
              console.warn(`  ⚠️ ${meta.symbol} K 線抓取失敗（重試 ${KLINE_FETCH_RETRIES} 次後放棄）：${err instanceof Error ? err.message.slice(0, 100) : err}`);
            }
          }
        }
      }
    }
    if ((i + 1) % 100 === 0 || i === metas.length - 1) {
      console.log(`  K線快取進度 ${i + 1}/${metas.length}（新抓 ${fetched}、命中 ${cachedHit}、失敗 ${failed}）`);
    }
  }
  return { fetched, cachedHit, failed, avgFetchMs: fetched > 0 ? totalMs / fetched : 0 };
}

/**
 * loadSeries factory：
 *   創業/科創 → 只讀 _klines-cache（缺檔回 null，計數警告）
 *   主板 → 「窗口涵蓋的 EM 快取」優先、L1 fallback：
 *     L1 是除權息日「不還權接合」序列（MEMORY cn_unadjusted_ex_date_splice —
 *     每日增量寫不回掃舊歷史），除息日當天 exchange 用「除權參考價」算漲停價、
 *     L1 的 prevClose 卻是原始昨收 → 精確封板判定漏抓該日全部除息漲停股
 *     （2026-06-05 實測漏 11/62，除息旺季 5-7 月最嚴重）。EM fqt=1 前復權
 *     序列自洽（實測同日 62/62 全中）→ 主板有覆蓋窗口的 EM 快取就用它。
 *     快取窗口不涵蓋（舊一輪殘檔）→ 退回 L1，不可拿短窗快取硬算 lead-in。
 */
function makeLoadSeries(
  growthSymbolSet: Set<string>,
  neededBegYmd8: string,
  neededEndYmd8: string,
): {
  loadSeries: (symbol: string) => BackfillSeriesBar[] | null;
  missing: { l1: number; growth: number };
  mainFromEm: { count: number };
} {
  const missing = { l1: 0, growth: 0 };
  const mainFromEm = { count: 0 };
  const readCache = (symbol: string): KlinesCacheFile | null => {
    try {
      return JSON.parse(readFileSync(path.join(KLINES_CACHE_DIR, `${symbol}.json`), 'utf-8')) as KlinesCacheFile;
    } catch {
      return null;
    }
  };
  const loadSeries = (symbol: string): BackfillSeriesBar[] | null => {
    const isGrowth = growthSymbolSet.has(symbol);
    if (isGrowth) {
      const cache = readCache(symbol);
      if (!cache || cache.bars.length === 0) {
        missing.growth++;
        return null;
      }
      return cache.bars;
    }
    // 主板：EM 快取（窗口涵蓋才算）優先
    const cache = readCache(symbol);
    if (cache && cache.begYmd8 <= neededBegYmd8 && cache.endYmd8 >= neededEndYmd8 && cache.bars.length > 0) {
      mainFromEm.count++;
      return cache.bars;
    }
    try {
      const j = JSON.parse(readFileSync(path.join(CANDLE_DIR, `${symbol}.json`), 'utf-8')) as {
        candles?: BackfillSeriesBar[];
      };
      const bars = j.candles ?? [];
      return bars.length > 0 ? bars : null;
    } catch {
      missing.l1++;
      return null;
    }
  };
  return { loadSeries, missing, mainFromEm };
}

/** 平均；空陣列 → null（不可回 0 — 0 是「平盤」有語意） */
function avgOrNull(arr: number[]): number | null {
  if (arr.length === 0) return null;
  return arr.reduce((s, v) => s + v, 0) / arr.length;
}

// ── manifest（續跑進度） ──────────────────────────────────────────────────────

interface BackfillManifest {
  schemaVersion: number;
  updatedAt: string;
  /** 已成功固化漲停池的日期（升冪） */
  done: string[];
  failed: Array<{ date: string; error: string }>;
}

async function loadManifest(): Promise<BackfillManifest> {
  try {
    const raw = await fs.readFile(MANIFEST_PATH, 'utf-8');
    const j = JSON.parse(raw) as BackfillManifest;
    if (Array.isArray(j.done) && Array.isArray(j.failed)) return j;
  } catch { /* 不存在/壞檔 → 全新 manifest */ }
  return { schemaVersion: CN_AGENTS_SCHEMA_VERSION, updatedAt: '', done: [], failed: [] };
}

async function saveManifest(m: BackfillManifest): Promise<void> {
  await fs.mkdir(path.dirname(MANIFEST_PATH), { recursive: true });
  m.updatedAt = new Date().toISOString();
  await atomicFsPut(MANIFEST_PATH, JSON.stringify(m, null, 2));
}

// ── L1 指數 K → 歷史 MarketOverview ──────────────────────────────────────────

interface RawCandle { date: string; close: number; volume?: number; amount?: number }

async function loadIndexCandles(filename: string): Promise<RawCandle[]> {
  try {
    const raw = await fs.readFile(path.join(CANDLE_DIR, filename), 'utf-8');
    const j = JSON.parse(raw) as { candles?: RawCandle[] };
    return j.candles ?? [];
  } catch {
    return [];
  }
}

/** date → 上證當日漲跌%（相鄰收盤自算） */
function buildPctMap(candles: RawCandle[]): Map<string, number> {
  const m = new Map<string, number>();
  for (let i = 1; i < candles.length; i++) {
    const prev = candles[i - 1].close;
    if (Number.isFinite(prev) && prev > 0 && Number.isFinite(candles[i].close)) {
      m.set(candles[i].date, ((candles[i].close / prev) - 1) * 100);
    }
  }
  return m;
}

// 註：舊版曾嘗試從 L1 指數 K 湊兩市成交額（buildTurnoverMap）— L1 無 amount 欄
// 永遠湊不出來，2026-06-12 起改打 EM 指數日K（fetchShSzTurnoverMap），已移除。

// ── 昨日炸板股今日漲跌（從 L1 個股 K 回查） ──────────────────────────────────

const pctCache = new Map<string, Map<string, number>>();

/** 裸碼 → L1 檔名；北交所(4/8/92 開頭)不在 L1 → null */
function cnCandleFilename(symbol: string): string | null {
  if (symbol.startsWith('6')) return `${symbol}.SS.json`;
  if (/^[03]/.test(symbol)) return `${symbol}.SZ.json`;
  return null;
}

async function getDailyPctMap(symbol: string): Promise<Map<string, number> | null> {
  const hit = pctCache.get(symbol);
  if (hit) return hit;
  const filename = cnCandleFilename(symbol);
  if (!filename) return null;
  try {
    const raw = await fs.readFile(path.join(CANDLE_DIR, filename), 'utf-8');
    const j = JSON.parse(raw) as { candles?: RawCandle[] };
    const m = buildPctMap(j.candles ?? []);
    if (pctCache.size >= PCT_CACHE_MAX_SYMBOLS) pctCache.clear();
    pctCache.set(symbol, m);
    return m;
  } catch {
    return null; // 不在 L1（非宇宙股/已下市）→ 跳過
  }
}

/** 昨日炸板股（非 ST）今日平均漲跌%；對到 0 檔 → null */
async function brokenAvgPctFromL1(
  yesterdayPool: LimitUpPoolDay | null,
  date: string,
): Promise<number | null> {
  if (!yesterdayPool || yesterdayPool.broken.length === 0) return null;
  const todayPctBySymbol = new Map<string, number>();
  for (const e of yesterdayPool.broken) {
    if (e.isST) continue;
    const m = await getDailyPctMap(e.symbol);
    const pct = m?.get(date);
    if (pct != null) todayPctBySymbol.set(e.symbol, pct);
  }
  return computeBrokenAvgPctFromQuotes(yesterdayPool.broken, todayPctBySymbol);
}

// ── main ─────────────────────────────────────────────────────────────────────

async function main() {
  const args = parseArgs();
  const dates = cnTradingDaysInclusive(args.from, args.to);
  console.log(`📅 回填區間 ${args.from} ~ ${args.to}（CN 交易日 ${dates.length} 天）${args.force ? '【--force 全部重抓】' : ''}`);
  if (dates.length === 0) { console.log('區間內無交易日，結束'); return; }

  // EM 窗口分流：窗內走 fetchPools、窗外走日K 重建（檔頭說明）
  const emWindowStart = nthLastCnTradingDay(getLastTradingDay('CN'), EM_POOL_WINDOW_TDAYS);
  const reconDates = dates.filter((d) => d < emWindowStart);
  const emDates = dates.filter((d) => d >= emWindowStart);
  console.log(`🪟 EM 窗口起點 ${emWindowStart} → 重建路 ${reconDates.length} 天、EM 路 ${emDates.length} 天`);

  // L1 指數 K（歷史 shIndexPct 主來源；EM 指數 K 補缺）
  const shCandles = await loadIndexCandles('000001.SS.json');
  const shPctByDate = buildPctMap(shCandles);
  if (shCandles.length === 0) {
    console.warn('⚠️ 讀不到 data/candles/CN/000001.SS.json — 歷史 shIndexPct 改用 EM 指數 K');
  }

  // 兩市成交額（EM 指數日K amount 欄相加；一次抓整窗 + lead-in，兩路共用）
  // L1 指數 K 無 amount 欄（只有 volume=成交量股數，不可冒充成交額）— 2026-06-12
  // 起改打 EM 指數 K（與線上 cnMarketBreadth ulist f6 同源同口徑）
  let turnoverByDate = new Map<string, number>();
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      if (attempt > 0) await sleep(3000);
      turnoverByDate = await fetchShSzTurnoverMap(
        toYmd8(minusCalendarDays(args.from, RECON_LEADIN_DAYS)),
        toYmd8(args.to),
      );
      console.log(`💰 EM 指數 K 兩市成交額：${turnoverByDate.size} 個交易日`);
      break;
    } catch (err) {
      if (attempt === 2) {
        console.warn(`⚠️ EM 指數 K 成交額抓取失敗（重試 3 次；${err instanceof Error ? err.message.slice(0, 120) : err}）→ 本輪兩市成交額 null、turnoverRatio5d null`);
      }
    }
  }

  // shIndexPct 補缺：L1 缺的日期用 EM 上證 K 相鄰收盤補（同窗已抓過，免費）
  try {
    const shEmBars = await fetchEmDailyBars('1.000001', toYmd8(minusCalendarDays(args.from, RECON_LEADIN_DAYS)), toYmd8(args.to));
    for (let i = 1; i < shEmBars.length; i++) {
      const d = shEmBars[i].date;
      if (!shPctByDate.has(d) && shEmBars[i - 1].close > 0) {
        shPctByDate.set(d, (shEmBars[i].close / shEmBars[i - 1].close - 1) * 100);
      }
    }
  } catch { /* L1 為主，補缺失敗可忍 */ }

  const historicalOverview = (date: string): MarketOverview => ({
    upCount: 0, // EM 窗內歷史拿不到家數（下游以 up+down===0 判退化）
    downCount: 0,
    flatCount: 0,
    turnoverShSzCny: turnoverByDate.get(date) ?? null,
    shIndexPct: shPctByDate.get(date) ?? null,
  });

  const manifest = await loadManifest();
  const doneSet = new Set(args.force ? [] : manifest.done);
  let fetched = 0;
  let skipped = 0;
  let failed = 0;

  // ── Pass 1a：EM 窗外 → 日K 重建路（source='candles-backfill'）──────────────
  if (reconDates.length > 0) {
    // 先檢查哪些日真的要做（命中既存檔就不用花錢建 universe / 抓成長板 K 線）
    const pendingRecon: string[] = [];
    for (const date of reconDates) {
      if (!args.force && (doneSet.has(date) || (await readLimitUpPoolDay(date)) !== null)) {
        doneSet.add(date);
        skipped++;
      } else {
        pendingRecon.push(date);
      }
    }
    console.log(`\n── Pass 1a：日K 重建（${pendingRecon.length}/${reconDates.length} 天待重建）──`);
    if (pendingRecon.length > 0) {
      const reconFrom = pendingRecon[0];
      const reconTo = pendingRecon[pendingRecon.length - 1];

      // universe：主板（L1）+ 創業/科創（EM K 線快取）；北交所刻意排除（backfillPools 檔頭）
      const mainMetas = loadMainBoardMetas();
      let growthMetas = await loadGrowthBoardMetas();
      if (args.growthLimit != null) {
        console.warn(`  ⚠️ --growth-limit ${args.growthLimit}：創業/科創只取前 ${args.growthLimit} 檔 — cm20 漲停統計會「低估」，主線全量跑不要帶這個參數`);
        growthMetas = growthMetas.slice(0, args.growthLimit);
      }
      const cacheBegYmd8 = toYmd8(minusCalendarDays(reconFrom, RECON_LEADIN_DAYS));
      const cacheEndYmd8 = toYmd8(reconTo);
      // --em-mainboard：主板也進 EM K 線快取（除息日漏抓修正，makeLoadSeries 檔頭）
      const cacheMetas = args.emMainboard ? [...growthMetas, ...mainMetas] : growthMetas;
      const klStat = await ensureEmKlinesCache(cacheMetas, cacheBegYmd8, cacheEndYmd8);
      console.log(`  📦 EM K 線快取：新抓 ${klStat.fetched}（均 ${klStat.avgFetchMs.toFixed(0)}ms/檔）、快取命中 ${klStat.cachedHit}、失敗 ${klStat.failed}`);

      const { loadSeries, missing, mainFromEm } = makeLoadSeries(
        new Set(growthMetas.map((m) => m.symbol)),
        cacheBegYmd8,
        cacheEndYmd8,
      );
      const reconT0 = Date.now();
      const recon = reconstructPools({
        metas: [...mainMetas, ...growthMetas],
        loadSeries,
        from: reconFrom,
        to: reconTo,
      });
      const reconMs = Date.now() - reconT0;
      console.log(
        `  🧮 重建 ${recon.size} 個交易日，耗時 ${(reconMs / 1000).toFixed(1)}s` +
        `（universe ${mainMetas.length + growthMetas.length} 檔；主板走 EM 快取 ${mainFromEm.count} 檔；` +
        `序列缺檔 L1=${missing.l1}、成長板=${missing.growth}）`,
      );
      if (!args.emMainboard && reconDates.some((d) => /-0[5-7]-/.test(d))) {
        console.warn('  ℹ️ 回填窗含 5-7 月（除息旺季）且未帶 --em-mainboard — 主板除息日漲停會漏抓（06-05 實測 11/62），建議帶 --em-mainboard 重跑');
      }
      if (missing.growth > 50) {
        console.warn(`  ⚠️ 成長板 K 線缺 ${missing.growth} 檔（--growth-limit 或抓取失敗）— cm20 統計低估`);
      }

      for (let i = 0; i < pendingRecon.length; i++) {
        const date = pendingRecon[i];
        try {
          const r = recon.get(date);
          // 守門：A 股交易日不可能 0 漲停 — 重建出 0 檔 = 該日全 universe 日K 缺漏
          // 或假日表把休市日誤判成交易日，記 failed 不落地
          if (!r || r.limitUp.length === 0) {
            throw new Error('重建漲停池 0 檔 — 該日日K 全缺或假日表誤判交易日，拒絕落地');
          }
          const yesterdayPool = await readLimitUpPoolDay(prevCnTradingDay(date));
          const day = buildLimitUpPoolDay({
            date,
            fetchedAt: new Date().toISOString(),
            source: 'candles-backfill',
            limitUp: r.limitUp,
            broken: r.broken,
            limitDown: r.limitDown,
            breadth: {
              upCount: r.overview.upCount, // 重建有真實家數（≠ EM 窗內歷史的 0）
              downCount: r.overview.downCount,
              flatCount: r.overview.flatCount,
              turnoverShSzCny: turnoverByDate.get(date) ?? null,
              shIndexPct: shPctByDate.get(date) ?? null,
            },
            yesterdayPool,
            yesterdayLimitUpAvgPct: avgOrNull(r.yestLimitUpReturns),
            yesterdayBrokenAvgPct: avgOrNull(r.yestBrokenReturns),
          });
          await saveLimitUpPoolDay(day);
          doneSet.add(date);
          fetched++;
          manifest.failed = manifest.failed.filter((f) => f.date !== date);
        } catch (err) {
          failed++;
          const msg = err instanceof Error ? err.message : String(err);
          manifest.failed = manifest.failed.filter((f) => f.date !== date);
          manifest.failed.push({ date, error: msg });
          console.warn(`  ⚠️ ${date} 重建失敗：${msg}`);
        }
        manifest.done = [...doneSet].sort();
        await saveManifest(manifest);
        if ((i + 1) % PROGRESS_EVERY === 0 || i === pendingRecon.length - 1) {
          console.log(`  重建進度 ${i + 1}/${pendingRecon.length}（成功 ${fetched}、失敗 ${failed}）`);
        }
      }
    }
  }

  // ── Pass 1b：EM 窗內 → 逐日抓取固化漲停池 ─────────────────────────────────
  console.log('\n── Pass 1b：EM 窗內逐日抓取漲停池（EM → akshare 備援）──');
  for (let i = 0; i < emDates.length; i++) {
    const date = emDates[i];
    try {
      if (!args.force && (doneSet.has(date) || (await readLimitUpPoolDay(date)) !== null)) {
        doneSet.add(date);
        skipped++;
      } else {
        if (fetched > 0) await sleep(THROTTLE_MS); // EM 請求間節流
        const pools = await fetchPools(date);
        // 守門：A 股交易日不可能 0 漲停 — 歷史回空多半是休市日誤判或上游退化（見檔頭）
        if (pools.limitUp.length === 0) {
          throw new Error('漲停池 0 檔 — 疑似 EM 歷史回空或假日表誤判交易日，拒絕落地');
        }
        await sleep(THROTTLE_MS);
        const yperf = await fetchYesterdayPoolPerformance(date);
        const yesterdayPool = await readLimitUpPoolDay(prevCnTradingDay(date));
        const yesterdayBrokenAvgPct = await brokenAvgPctFromL1(yesterdayPool, date);
        const day = buildLimitUpPoolDay({
          date,
          fetchedAt: new Date().toISOString(),
          source: pools.source,
          limitUp: pools.limitUp,
          broken: pools.broken,
          limitDown: pools.limitDown,
          breadth: historicalOverview(date),
          yesterdayPool,
          yesterdayLimitUpAvgPct: yperf.avgPct,
          yesterdayBrokenAvgPct,
        });
        await saveLimitUpPoolDay(day);
        doneSet.add(date);
        fetched++;
      }
      manifest.failed = manifest.failed.filter((f) => f.date !== date);
    } catch (err) {
      failed++;
      const msg = err instanceof Error ? err.message : String(err);
      manifest.failed = manifest.failed.filter((f) => f.date !== date);
      manifest.failed.push({ date, error: msg });
      console.warn(`  ⚠️ ${date} 失敗：${msg}`);
    }
    manifest.done = [...doneSet].sort();
    await saveManifest(manifest); // 每日落 manifest，中斷可續跑
    if ((i + 1) % PROGRESS_EVERY === 0 || i === emDates.length - 1) {
      console.log(`  進度 ${i + 1}/${emDates.length}（累計成功 ${fetched}、跳過 ${skipped}、失敗 ${failed}）`);
    }
  }

  // ── Pass 2：組裝 MarketBreadthDay → 情緒週期全序列重放 ───────────────────
  console.log('\n── Pass 2：組裝市場寬度 + 情緒週期（與線上同一個 classifyEmotionCycle）──');
  const poolDir = path.join(process.cwd(), 'data', 'cn-agents', 'limitup-pool');
  const poolFiles = await fs.readdir(poolDir).catch(() => [] as string[]);
  const poolDates = poolFiles
    .map((f) => (f.match(/^(\d{4}-\d{2}-\d{2})\.json$/) ?? [])[1])
    .filter((d): d is string => !!d && d <= args.to)
    .sort();
  if (poolDates.length === 0) {
    console.error('❌ 沒有任何漲停池日檔可組裝（Pass 1 全部失敗？），結束');
    process.exit(1);
  }

  const series: MarketBreadthDay[] = [];
  const turnoverHistory: Array<{ date: string; turnover: number | null }> = [];
  for (const d of poolDates) {
    const pool = await readLimitUpPoolDay(d);
    if (!pool) continue;
    series.push(buildMarketBreadthDay({ pool, turnoverHistory }));
    turnoverHistory.push({ date: d, turnover: pool.breadth.turnoverShSzCny });
  }
  const cycles = classifyEmotionCycle(series);

  const generatedAt = new Date().toISOString();
  for (let i = 0; i < series.length; i++) {
    await saveBreadthDay({
      schemaVersion: CN_AGENTS_SCHEMA_VERSION,
      date: series[i].date,
      generatedAt,
      cycleRulesVersion: CYCLE_RULES_VERSION,
      breadth: series[i],
      cycle: cycles[i],
    });
  }

  // 重建 index（直接整檔寫最後 BREADTH_INDEX_MAX_DAYS 日，不走 upsert 120 次）
  const tail = series
    .map((b, j) => ({ date: b.date, breadth: b, cycle: cycles[j] }))
    .slice(-BREADTH_INDEX_MAX_DAYS);
  const indexFile: BreadthIndexFile = {
    schemaVersion: CN_AGENTS_SCHEMA_VERSION,
    updatedAt: generatedAt,
    days: tail,
  };
  await fs.mkdir(path.dirname(BREADTH_INDEX_PATH), { recursive: true });
  await atomicFsPut(BREADTH_INDEX_PATH, JSON.stringify(indexFile));

  // ── 總結 ──────────────────────────────────────────────────────────────────
  const stageCount = new Map<string, number>();
  for (const c of cycles) stageCount.set(c.stageLabel, (stageCount.get(c.stageLabel) ?? 0) + 1);
  const last = cycles[cycles.length - 1];
  console.log(`\n🎉 完成：Pass 1 新抓 ${fetched}、跳過 ${skipped}、失敗 ${failed}；Pass 2 組裝 ${series.length} 日、index 收最後 ${tail.length} 日`);
  console.log(`   階段分佈：${[...stageCount.entries()].map(([k, v]) => `${k}=${v}`).join('、')}`);
  console.log(`   最新一日 ${last.date}：${last.stageLabel}（情緒分 ${last.emotionScore}、${last.strategyLabel}、倉位 ${last.positionPct[0]}-${last.positionPct[1]}%）`);
  if (failed > 0) {
    console.log(`   ⚠️ ${failed} 日失敗（已記 manifest.failed），重跑本指令會自動重試`);
  }
}

main().catch((err) => { console.error('❌:', err); process.exit(1); });
