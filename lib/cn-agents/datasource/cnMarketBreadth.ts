/**
 * 陸股全市場寬度 provider — 漲跌家數 + 兩市成交額 + 上證漲跌%
 *
 * ⚠️ 僅當日即時：兩個源都只給「現在」的快照，不支援歷史 date。
 * 歷史回填走 L1 K 線另路（candles-backfill，見 breadth 組裝層），不在本檔。
 *
 * 資料源（2026-06-12 實測）：
 *   1. 漲跌家數 primary：akshare 橋接 'market_activity'（ak.stock_market_activity_legu，
 *      乐咕乐股；單發拿 上涨/下跌/平盘/涨停/跌停 全套家數）。
 *      實測 2026-06-12 收盤：上涨 3708 / 下跌 1413 / 平盘 73。
 *   2. 兩市成交額 + 上證漲跌：EM push2 ulist（上證 1.000001 + 深證成指 0.399001），
 *      f6=成交額(元，raw) 相加；f3=漲跌% ×100 定點數（112 → +1.12%）；
 *      f12=代碼（'000001' 字串，用它對位不可靠 index 順序）。
 *      實測 2026-06-12：滬 1.537 兆 + 深 1.678 兆 = 3.215 兆，上證 +1.12%。
 *
 * 退化策略（呼叫端據此記 _health degraded）：
 *   - akshare 家數失敗（未裝/被擋/timeout → bridge 回 []）→ upCount/downCount/flatCount
 *     全 0 + source='em-push2ex'（= 只剩 EM 量能資料）。家數全 0 在真實交易日不可能，
 *     呼叫端用「up+down===0」即可判退化。
 *   - EM ulist 失敗 → turnoverShSzCny / shIndexPct 為 null（types 本就 nullable）。
 *   - 兩源全失敗 → throw。
 */

import { fetchJsonWithCurlFallback } from '@/lib/datasource/curlFetch';
import { runAkshareBridge } from '@/lib/datasource/akshareBridge';
import type { CnAgentsDataSource, MarketOverview } from '../types';

const ULIST_URL = 'https://push2.eastmoney.com/api/qt/ulist.np/get'
  + '?secids=1.000001,0.399001&fields=f2,f3,f6,f12,f14';

const AKSHARE_TIMEOUT_MS = 45_000;

interface UlistDiffEntry {
  /** 最新點位 ×100 */
  f2?: number | string;
  /** 漲跌 % ×100（112 = +1.12%）；盤前可能回 '-' 字串 */
  f3?: number | string;
  /** 成交額（元，raw 不縮放） */
  f6?: number | string;
  /** 代碼字串 '000001' / '399001' */
  f12?: string;
  f14?: string;
}

interface UlistResponse {
  rc?: number;
  data?: { total?: number; diff?: UlistDiffEntry[] } | null;
}

/** akshare market_activity 橋接輸出（scripts/akshare_bridge.py 定義的欄名） */
interface MarketActivityRow {
  up?: number | null;
  down?: number | null;
  flat?: number | null;
  limitUp?: number | null;
  limitDown?: number | null;
  suspended?: number | null;
  statTime?: string | null;
}

function finiteOrNull(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim() !== '' && v !== '-') {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/**
 * 抓全市場寬度概況（當日即時）。
 * source：'akshare' = 家數來自乐咕（正常）；'em-push2ex' = 家數退化全 0、只剩 EM 量能。
 */
export async function fetchMarketOverview(): Promise<{
  overview: MarketOverview;
  source: CnAgentsDataSource;
}> {
  // ── 1) 漲跌家數（akshare primary；bridge 永不 throw，失敗回 []） ──────────
  const actRows = (await runAkshareBridge('market_activity', 'now', AKSHARE_TIMEOUT_MS)) as MarketActivityRow[];
  const act = actRows.length > 0 ? actRows[0] : null;

  // ── 2) 兩市成交額 + 上證漲跌（EM ulist） ─────────────────────────────────
  let turnoverShSzCny: number | null = null;
  let shIndexPct: number | null = null;
  let ulistOk = false;
  let ulistErr: unknown = null;
  try {
    const { data: resp } = await fetchJsonWithCurlFallback<UlistResponse>(ULIST_URL, { timeoutMs: 12_000 });
    const diff = resp?.data?.diff ?? [];
    // 用 f12 對位，不可信 diff 順序
    const sh = diff.find((d) => d.f12 === '000001');
    const sz = diff.find((d) => d.f12 === '399001');
    const shTurnover = finiteOrNull(sh?.f6);
    const szTurnover = finiteOrNull(sz?.f6);
    if (shTurnover !== null && szTurnover !== null) {
      turnoverShSzCny = shTurnover + szTurnover;
    } else if (shTurnover !== null || szTurnover !== null) {
      // 單邊缺值（罕見）→ 不硬湊半套「兩市」成交額，保持 null 比給錯數字好
      turnoverShSzCny = null;
    }
    const shPctRaw = finiteOrNull(sh?.f3);
    shIndexPct = shPctRaw === null ? null : shPctRaw / 100; // f3 是 ×100 定點數
    ulistOk = diff.length > 0;
  } catch (err) {
    ulistErr = err;
  }

  // ── 3) 兩源全失敗 → throw（單源活著就出貨，缺的欄位退化） ─────────────────
  if (!act && !ulistOk) {
    const msg = ulistErr instanceof Error ? ulistErr.message : String(ulistErr);
    throw new Error(`cnMarketBreadth: akshare 家數與 EM ulist 都失敗：${msg}`);
  }

  const overview: MarketOverview = {
    upCount: finiteOrNull(act?.up) ?? 0,
    downCount: finiteOrNull(act?.down) ?? 0,
    flatCount: finiteOrNull(act?.flat) ?? 0,
    turnoverShSzCny,
    shIndexPct,
  };
  return { overview, source: act ? 'akshare' : 'em-push2ex' };
}
