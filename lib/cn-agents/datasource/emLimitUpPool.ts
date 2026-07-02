/**
 * EastMoney push2ex 漲停池系列 provider — 漲停 / 炸板 / 跌停 / 昨日漲停（支援歷史 date）
 *
 * 公開唯讀 GET，欄位於 2026-06-12 對 date=20260611 實測確認（69 漲停 / 30 炸板 / 32 跌停 /
 * 70 昨漲停）。設計給 cn-agents P1 情緒週期狀態機當輸入，鏡像 lib/cn-sanse/ 隔離先例，
 * 不碰既有 provider 路由。
 *
 * 欄位對照（×1000 = EM 原生定點數刻度）：
 *   c=代號 n=名稱 zdp=漲跌幅% p=價格×1000 amount=成交額(元) ltsz=流通市值(元)
 *   fund=封單額(元) fbt/lbt=首/末次封板時間(HHMMSS 數字，92500=09:25:00)
 *   zbc=炸板次數 lbc=連板數 zttj={days,ct}=幾天幾板 hybk=行業
 *   跌停池另有 days=連續跌停天數、oc=開板次數
 *
 * 陷阱（實測踩過，改 endpoint 前先 curl 驗證）：
 *   1. sort 參數是「必要」不是裝飾 — 各池 sort 欄位不同，帶錯欄位或不帶 sort 時
 *      server 回 tc 正常但 pool 永遠空陣列（不報錯！）：
 *        漲停池/炸板池 → sort=fbt:asc；跌停池 → sort=fund:asc；昨日漲停 → sort=zs:desc
 *   2. 回應的 qdate 是「server 當下日期」不是資料日期 — 不可拿 qdate 驗證 date 參數
 *      有沒有生效（要比 pool 內容；歷史 date 實測有效）
 *   3. 一字板判定：歷史 date 模式拿不到分時，用 fbt<=093000 且 zbc===0 近似
 *      （集合競價/開盤即封板且全日未開板 ≈ 一字）— 這是 proxy，會把「09:25 封板後
 *      盤中縮量但沒開板」的準一字也算進來，統計用途可接受
 *
 * 失敗鏈：EM 直連（fetchJsonWithCurlFallback，自帶 node fetch→curl→本機代理）
 *   → akshare 橋接備援（同源不同管道，EM 擋 UA 時常仍通；欄名已在 Python 端對齊
 *      EM 原生，本檔一個 mapper 兩邊通吃）→ 都失敗 throw。
 */

import { fetchJsonWithCurlFallback } from '@/lib/datasource/curlFetch';
import { runAkshareBridge, type AkshareType } from '@/lib/datasource/akshareBridge';
import { classifyCnBoard, isStName } from '../cnBoard';
import type {
  BrokenEntry,
  CnAgentsDataSource,
  LimitDownEntry,
  LimitUpEntry,
} from '../types';

const EM_HOST = 'https://push2ex.eastmoney.com';
const EM_UT = '7eea3edcaed734bea9cbfc24409ed989';
const PAGE_SIZE = 1000;
/** 頁間節流（pagesize=1000 一般一頁就完，>1 頁才會用到） */
const PAGE_THROTTLE_MS = 250;
/** 防 tc 異常大造成無限翻頁 */
const MAX_PAGES = 10;
/** 一字板 proxy 門檻：首封 <= 09:30:00 且全日未炸板 */
const ONE_WORD_FBT_CUTOFF = 93000;
/** akshare 子程序 timeout（首次 import akshare ~2-3s + EM 請求） */
const AKSHARE_TIMEOUT_MS = 45_000;

// ── EM 原生回應形狀（akshare 備援的 Python 端輸出也對齊這組欄名） ──────────────

interface EmRawPoolEntry {
  c?: string | number;
  n?: string | null;
  zdp?: number | null;
  /** 價格 ×1000 */
  p?: number | null;
  amount?: number | null;
  ltsz?: number | null;
  fund?: number | null;
  fbt?: number | null;
  lbt?: number | null;
  zbc?: number | null;
  lbc?: number | null;
  /** 跌停池：連續跌停天數 */
  days?: number | null;
  /** 跌停池：開板次數 */
  oc?: number | null;
  hybk?: string | null;
  zttj?: { days?: number; ct?: number } | null;
}

interface EmPoolResponse {
  rc?: number;
  data?: { tc?: number; qdate?: number; pool?: EmRawPoolEntry[] } | null;
}

type PoolKind = 'zt' | 'zb' | 'dt' | 'yzt';

/** 各池 endpoint + 必帶 sort（陷阱 1：sort 欄位錯 → pool 靜默回空） */
const POOL_ENDPOINTS: Record<PoolKind, { path: string; sort: string; akshareType: AkshareType; label: string }> = {
  zt: { path: 'getTopicZTPool', sort: 'fbt:asc', akshareType: 'zt_pool', label: '漲停池' },
  zb: { path: 'getTopicZBPool', sort: 'fbt:asc', akshareType: 'zb_pool', label: '炸板池' },
  dt: { path: 'getTopicDTPool', sort: 'fund:asc', akshareType: 'dt_pool', label: '跌停池' },
  yzt: { path: 'getYesterdayZTPool', sort: 'zs:desc', akshareType: 'yzt_pool', label: '昨日漲停池' },
};

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** 'YYYY-MM-DD' → 'YYYYMMDD'（容忍已是 8 位的輸入） */
function toYmd8(date: string): string {
  const ymd = date.replace(/-/g, '');
  if (!/^\d{8}$/.test(ymd)) throw new Error(`emLimitUpPool: 非法日期 '${date}'（要 YYYY-MM-DD）`);
  return ymd;
}

function finiteOrNull(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/** EM 代號偶有前導零被吃（數字型），統一 6 位字串 */
function toSymbol6(c: string | number | undefined): string {
  return String(c ?? '').replace(/\.\d+$/, '').padStart(6, '0');
}

/** HHMMSS 數字（92500）→ 'HH:MM:SS'（'09:25:00'） */
function fmtSealTime(v: number | null | undefined): string | null {
  const n = finiteOrNull(v ?? null);
  if (n === null) return null;
  const s = String(Math.trunc(n)).padStart(6, '0');
  return `${s.slice(0, 2)}:${s.slice(2, 4)}:${s.slice(4, 6)}`;
}

// ── EM 直連（含分頁） ─────────────────────────────────────────────────────────

async function fetchEmPoolAllPages(kind: PoolKind, ymd8: string): Promise<EmRawPoolEntry[]> {
  const { path, sort, label } = POOL_ENDPOINTS[kind];
  const rows: EmRawPoolEntry[] = [];
  let expected = Infinity;
  for (let page = 0; page < MAX_PAGES && rows.length < expected; page++) {
    if (page > 0) await sleep(PAGE_THROTTLE_MS);
    const url = `${EM_HOST}/${path}?ut=${EM_UT}&dpt=wz.ztzt`
      + `&Pageindex=${page}&pagesize=${PAGE_SIZE}`
      + `&sort=${encodeURIComponent(sort)}&date=${ymd8}`;
    const { data: resp } = await fetchJsonWithCurlFallback<EmPoolResponse>(url, { timeoutMs: 15_000 });
    if (resp?.rc !== 0 || !resp.data) throw new Error(`EM ${label} rc=${resp?.rc ?? 'null'}（data 空）`);
    expected = finiteOrNull(resp.data.tc) ?? 0;
    const pagePool = resp.data.pool ?? [];
    // 陷阱 1 偵測：tc>0 但第一頁就空 = sort 欄位被 server 改掉/失效，明確 throw 觸發備援
    if (page === 0 && expected > 0 && pagePool.length === 0) {
      throw new Error(`EM ${label} tc=${expected} 但 pool 空 — sort=${sort} 疑似失效`);
    }
    if (pagePool.length === 0) break;
    rows.push(...pagePool);
  }
  return rows;
}

/** EM 直連失敗 → akshare 備援（回 [] 視為備援也失敗，由呼叫端 throw） */
async function fetchPoolWithFallback(
  kind: PoolKind,
  ymd8: string,
): Promise<{ rows: EmRawPoolEntry[]; source: CnAgentsDataSource }> {
  const { akshareType, label } = POOL_ENDPOINTS[kind];
  let emErr: unknown = null;
  try {
    const rows = await fetchEmPoolAllPages(kind, ymd8);
    return { rows, source: 'em-push2ex' };
  } catch (err) {
    emErr = err;
  }
  // akshare 橋接（永不 throw，失敗回 []）— 欄名已在 Python 端對齊 EM
  const akRows = (await runAkshareBridge(akshareType, ymd8, AKSHARE_TIMEOUT_MS)) as EmRawPoolEntry[];
  if (akRows.length > 0) return { rows: akRows, source: 'akshare' };
  // 注意：跌停池真的可能 0 檔，但這裡是「EM 已確定失敗 + akshare 回空」，
  // 無法區分「真 0 檔」與「akshare 也掛」，保守 throw 讓 cron 記 _health 失敗
  const msg = emErr instanceof Error ? emErr.message : String(emErr);
  throw new Error(`${label} EM 直連與 akshare 備援都失敗（date=${ymd8}）：${msg}`);
}

// ── raw → 型別 mapper（單一事實在 lib/cn-agents/types.ts） ────────────────────

function mapLimitUp(r: EmRawPoolEntry): LimitUpEntry {
  const symbol = toSymbol6(r.c);
  const name = r.n ?? '';
  const fbt = finiteOrNull(r.fbt);
  const zbc = finiteOrNull(r.zbc);
  const zttj = r.zttj ?? null;
  return {
    symbol,
    name,
    board: classifyCnBoard(symbol),
    pct: finiteOrNull(r.zdp) ?? 0,
    close: (finiteOrNull(r.p) ?? 0) / 1000,
    turnoverCny: finiteOrNull(r.amount),
    floatMvCny: finiteOrNull(r.ltsz),
    sealAmountCny: finiteOrNull(r.fund),
    firstSealTime: fmtSealTime(r.fbt),
    lastSealTime: fmtSealTime(r.lbt),
    brokenTimes: zbc,
    consecBoards: finiteOrNull(r.lbc) ?? 1,
    boardsPattern: zttj && Number.isFinite(zttj.days) && Number.isFinite(zttj.ct)
      ? `${zttj.days}/${zttj.ct}` : null,
    industry: r.hybk ?? null,
    // 一字板 proxy（陷阱 3）：開盤即封 + 全日未炸板；fbt 缺值不敢判一字
    isOneWord: fbt !== null && fbt <= ONE_WORD_FBT_CUTOFF && zbc === 0,
    isST: isStName(name),
  };
}

function mapBroken(r: EmRawPoolEntry): BrokenEntry {
  const symbol = toSymbol6(r.c);
  const name = r.n ?? '';
  return {
    symbol,
    name,
    board: classifyCnBoard(symbol),
    pct: finiteOrNull(r.zdp) ?? 0,
    close: (finiteOrNull(r.p) ?? 0) / 1000,
    brokenTimes: finiteOrNull(r.zbc),
    firstSealTime: fmtSealTime(r.fbt),
    industry: r.hybk ?? null,
    isST: isStName(name),
  };
}

function mapLimitDown(r: EmRawPoolEntry): LimitDownEntry {
  const symbol = toSymbol6(r.c);
  const name = r.n ?? '';
  return {
    symbol,
    name,
    board: classifyCnBoard(symbol),
    pct: finiteOrNull(r.zdp) ?? 0,
    close: (finiteOrNull(r.p) ?? 0) / 1000,
    consecDownBoards: finiteOrNull(r.days),
    industry: r.hybk ?? null,
    isST: isStName(name),
  };
}

// ── 對外 API ─────────────────────────────────────────────────────────────────

/**
 * 抓某交易日的漲停 / 炸板 / 跌停三池。
 * date=YYYY-MM-DD（內部轉 YYYYMMDD）；三池循序抓（池間沿用頁間 250ms 節流，
 * 避免 EM 對突發三連發限流）。source = 三池中「最退化」者（任一池走 akshare 即標 akshare）。
 */
export async function fetchPools(date: string): Promise<{
  limitUp: LimitUpEntry[];
  broken: BrokenEntry[];
  limitDown: LimitDownEntry[];
  source: CnAgentsDataSource;
}> {
  const ymd8 = toYmd8(date);
  const zt = await fetchPoolWithFallback('zt', ymd8);
  await sleep(PAGE_THROTTLE_MS);
  const zb = await fetchPoolWithFallback('zb', ymd8);
  await sleep(PAGE_THROTTLE_MS);
  const dt = await fetchPoolWithFallback('dt', ymd8);
  const degraded = [zt, zb, dt].some((x) => x.source === 'akshare');
  return {
    limitUp: zt.rows.map(mapLimitUp),
    broken: zb.rows.map(mapBroken),
    limitDown: dt.rows.map(mapLimitDown),
    source: degraded ? 'akshare' : 'em-push2ex',
  };
}

/**
 * 昨日漲停股池「今日表現」（接力賺錢效應）。
 * getYesterdayZTPool 的 zdp = 該股「今日」漲跌幅 → 平均即昨日打板者今日的平均損益。
 * EM 成功但池空（理論上交易日不會發生）→ { avgPct: null, count: 0 }；
 * EM 失敗且 akshare 也空 → throw（無法區分真空與備援失敗）。
 */
export async function fetchYesterdayPoolPerformance(date: string): Promise<{
  avgPct: number | null;
  count: number;
  source: CnAgentsDataSource;
}> {
  const ymd8 = toYmd8(date);
  const { rows, source } = await fetchPoolWithFallback('yzt', ymd8);
  const pcts = rows.map((r) => finiteOrNull(r.zdp)).filter((v): v is number => v !== null);
  const avgPct = pcts.length > 0
    ? pcts.reduce((s, v) => s + v, 0) / pcts.length
    : null;
  return { avgPct, count: rows.length, source };
}
