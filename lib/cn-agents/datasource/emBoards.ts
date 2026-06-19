/**
 * EM 板塊快照 provider — 行業/概念板塊全量清單（漲幅/成交額/主力淨流入/領漲股）
 *
 * 資料源：EastMoney push2 clist 行情列表端點。2026-06-12 curl 實測修正規格書的
 * fs 對照（規格書原寫 t:2=概念/t:1=行業，與線上不符，以實測為準）：
 *   m:90+t:1 = 地域板塊（~31 條，雲南板塊/西藏板塊等）— 不取
 *   m:90+t:2 = 行業板塊（~496 條，鉬/鉛鋅/銅/診斷服務等 2025 新版細分行業）
 *   m:90+t:3 = 概念板塊（~494 條，黃金概念/昨日打二板以上表現等）
 *
 * 欄位對照（fltt=2 → 數值欄為 number；停牌/盤前個別欄可能回 '-' 字串）：
 *   f12=板塊代碼 BKxxxx、f14=名稱、f3=漲跌幅 %、f6=成交額（元）、
 *   f62=主力淨流入（元）、f104=上漲家數、f105=下跌家數、
 *   f128=領漲股名、f140=領漲股代碼、f136=領漲股漲跌幅 %
 *
 * 陷阱：
 *   - 盤中抓取時排名即時變動，跨頁可能重複/漏 — 以 code dedup（保留先到的）
 *   - limitUpCount / pct5d 此層一律 null，由組裝層（boards 寫入時）補
 *   - EM push2 本機直連時段性 502/TLS reset（見記憶 data_sources_cn_quote）。
 *     2026-06-12 實測：好時段單請求成功率 ~60%，壞時段 push2 主站連續 10 連發全滅
 *     （curl 000 TLS reset、node fetch 502），但同時刻 push2delay / push2his 鏡像
 *     仍 200 且回傳結構完全相同 — 因此每頁走「主站→鏡像」host failover + 退避重試，
 *     成功的 host 以模組級 cache 黏住（仿 curlFetch 的 proxy cache）。
 *     push2delay 是 15 分鐘延遲鏡像：盤後 cron 抓快照無差異；盤中只在主站掛時
 *     才會輪到它，落後 15 分鐘可接受（板塊強弱是日級訊號）。
 *   - akshare 板塊備援刻意不在此層接（P2 再加），失敗一律 throw 給 cron 記健康
 */

import { fetchJsonWithCurlFallback } from '@/lib/datasource/curlFetch';
import type { BoardEntry, BoardKind, CnAgentsDataSource } from '@/lib/cn-agents/types';

const PAGE_SIZE = 100;
/** 翻頁上限（496 條 → 5 頁；給 20 頁餘裕，防 total 異常時無限迴圈） */
const MAX_PAGES = 20;
const PAGE_GAP_MS = 250;
const TIMEOUT_MS = 15_000;

/** EM fs 參數對照（2026-06-12 實測，見檔頭） */
const FS_BY_KIND: Record<BoardKind, string> = {
  industry: 'm:90+t:2',
  concept: 'm:90+t:3',
};

/** push2 clist 單列（fltt=2 數值欄為 number，缺值常回 '-'） */
interface EmClistRow {
  f12?: unknown; // 板塊代碼
  f14?: unknown; // 名稱
  f3?: unknown;  // 漲跌幅 %
  f6?: unknown;  // 成交額（元）
  f62?: unknown; // 主力淨流入（元）
  f104?: unknown; // 上漲家數
  f105?: unknown; // 下跌家數
  f128?: unknown; // 領漲股名
  f140?: unknown; // 領漲股代碼
  f136?: unknown; // 領漲股漲跌幅 %
}

interface EmClistResponse {
  rc?: number;
  data?: { total?: number; diff?: EmClistRow[] } | null;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** clist host failover 順序（見檔頭陷阱：壞時段主站全滅但鏡像活著） */
const CLIST_HOSTS = [
  'push2.eastmoney.com',
  'push2delay.eastmoney.com', // 15 分鐘延遲鏡像（盤後無差異）
  'push2his.eastmoney.com',
];

/** 每輪（跑遍所有 host 算一輪）重試次數與輪間退避 */
const PAGE_RETRIES = 3;
const RETRY_BACKOFF_MS = [500, 1000];

/** 最近成功的 host — 黏住優先重用（仿 curlFetch workingProxyCache） */
let workingHost: string | null = null;

/**
 * 帶 host failover + 退避重試的單頁抓取。
 * fetchJsonWithCurlFallback 內已含 curl/本機代理 fallback，這層只管換 host 與重試。
 */
async function fetchPageWithRetry(urlPath: string): Promise<EmClistResponse> {
  const hosts = workingHost
    ? [workingHost, ...CLIST_HOSTS.filter((h) => h !== workingHost)]
    : [...CLIST_HOSTS];
  let lastErr: unknown = null;
  for (let attempt = 0; attempt < PAGE_RETRIES; attempt++) {
    if (attempt > 0) await sleep(RETRY_BACKOFF_MS[Math.min(attempt - 1, RETRY_BACKOFF_MS.length - 1)]);
    for (const host of hosts) {
      try {
        const { data } = await fetchJsonWithCurlFallback<EmClistResponse>(
          `https://${host}${urlPath}`,
          { timeoutMs: TIMEOUT_MS },
        );
        workingHost = host;
        return data;
      } catch (err) {
        lastErr = err;
      }
    }
  }
  throw lastErr;
}

/** EM 數值欄防呆：number 直接收、字串可 parse 才收，'-' / null / undefined → null */
function toNum(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string' && v !== '' && v !== '-') {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function toStr(v: unknown): string | null {
  if (typeof v === 'string' && v !== '' && v !== '-') return v;
  return null;
}

/** 組 URL path（host 由 fetchPageWithRetry 的 failover 決定） */
function buildUrlPath(kind: BoardKind, pn: number): string {
  return '/api/qt/clist/get'
    + `?pn=${pn}&pz=${PAGE_SIZE}&po=1&np=1&fltt=2&invt=2&fid=f3`
    + `&fs=${FS_BY_KIND[kind]}`
    + '&fields=f12,f14,f3,f6,f62,f104,f105,f128,f140,f136';
}

/**
 * 抓單一 kind 的板塊快照全量（pz=100 翻頁到 total，頁間 250ms）。
 * rank 按 pct 降冪 1-based 重排（不信任跨頁順序）；limitUpCount/pct5d 填 null 由組裝層補。
 * 失敗（第一頁就拿不到合法 diff）→ throw。
 */
export async function fetchBoardSnapshot(
  kind: BoardKind,
): Promise<{ entries: BoardEntry[]; source: CnAgentsDataSource }> {
  const seen = new Set<string>();
  const rows: EmClistRow[] = [];
  let total = Number.POSITIVE_INFINITY;

  for (let pn = 1; pn <= MAX_PAGES && rows.length < total; pn++) {
    if (pn > 1) await sleep(PAGE_GAP_MS);
    const data = await fetchPageWithRetry(buildUrlPath(kind, pn));
    const diff = data?.data?.diff;
    if (!Array.isArray(diff) || diff.length === 0) {
      // 第一頁就空 = 端點異常（限流 stub / 結構變更），不可默默回空池
      if (pn === 1) throw new Error(`EM clist ${kind} 第一頁無資料（rc=${data?.rc}）`);
      break; // 後續頁空 = 翻完了
    }
    if (typeof data?.data?.total === 'number' && data.data.total > 0) total = data.data.total;
    for (const row of diff) {
      const code = toStr(row.f12);
      if (!code || seen.has(code)) continue; // 盤中翻頁位移 → 跨頁重複，保留先到
      seen.add(code);
      rows.push(row);
    }
    if (diff.length < PAGE_SIZE) break;
  }

  const entries: BoardEntry[] = rows
    .map((row): BoardEntry | null => {
      const code = toStr(row.f12);
      const name = toStr(row.f14);
      if (!code || !name) return null;
      return {
        code,
        name,
        kind,
        // 盤前/異常時 f3 可能 '-' → 以 0 計（排序自然沉底），不丟整列
        pct: toNum(row.f3) ?? 0,
        turnoverCny: toNum(row.f6),
        mainNetCny: toNum(row.f62),
        upCount: toNum(row.f104),
        downCount: toNum(row.f105),
        leaderSymbol: toStr(row.f140),
        leaderName: toStr(row.f128),
        leaderPct: toNum(row.f136),
        limitUpCount: null, // 組裝層 join 漲停池 industry 補（概念版 P2 前維持 null）
        rank: 0, // 下方排序後回填
        pct5d: null, // 組裝層讀前 4 日檔自算
      };
    })
    .filter((e): e is BoardEntry => e !== null)
    .sort((a, b) => b.pct - a.pct)
    .map((e, i) => ({ ...e, rank: i + 1 }));

  return { entries, source: 'em-push2ex' };
}

// ── 板塊成分股（/cn-sectors 點開板塊看逐檔績效用，lazy on-demand） ─────────────

/** 板塊成分股單筆（即時欄位；歷史報酬由 boardMembersPerf 另抓 K 線算） */
export interface BoardMember {
  /** 6 位裸碼 */
  code: string;
  name: string;
  /** 帶交易所後綴（600xxx.SS / 000xxx.SZ），給 Tencent/EM 日K 用 */
  symbol: string;
  /** 當日漲跌幅 % */
  pct: number;
  /** 成交額（元） */
  turnoverCny: number | null;
}

/**
 * 6 位裸碼 → 帶後綴 symbol。A 股前綴規則：
 *   6/9 → 上海(.SS)；0/2/3 → 深圳(.SZ)；4/8 → 北交所（無 Tencent qfq，回 null 跳過）
 * 用代號前綴判別（不依賴 EM f13），避免欄位缺漏。
 */
function memberCodeToSymbol(code: string): string | null {
  const c = code[0];
  if (c === '6' || c === '9') return `${code}.SS`;
  if (c === '0' || c === '2' || c === '3') return `${code}.SZ`;
  return null; // 北交所 4/8 開頭：v1 不支援
}

/**
 * 抓某板塊（BKxxxx）成分股全量清單（pz=100 翻頁，code dedup）。
 * fs=b:BKxxxx 是 EM 板塊成分股標準查詢；回當日漲跌幅 + 成交額（歷史報酬另抓）。
 * 北交所成分（4/8 開頭）跳過。失敗（第一頁就無資料）→ throw 給 caller 處理。
 */
export async function fetchBoardMembers(boardCode: string): Promise<BoardMember[]> {
  if (!/^BK\d+$/i.test(boardCode)) throw new Error(`fetchBoardMembers: 非法板塊代碼 '${boardCode}'`);
  const seen = new Set<string>();
  const out: BoardMember[] = [];
  let total = Number.POSITIVE_INFINITY;

  for (let pn = 1; pn <= MAX_PAGES && out.length < total; pn++) {
    if (pn > 1) await sleep(PAGE_GAP_MS);
    const urlPath =
      '/api/qt/clist/get'
      + `?pn=${pn}&pz=${PAGE_SIZE}&po=1&np=1&fltt=2&invt=2&fid=f3`
      + `&fs=b:${boardCode}`
      + '&fields=f12,f14,f3,f6';
    const data = await fetchPageWithRetry(urlPath);
    const diff = data?.data?.diff;
    if (!Array.isArray(diff) || diff.length === 0) {
      if (pn === 1) throw new Error(`EM clist 板塊 ${boardCode} 第一頁無資料（rc=${data?.rc}）`);
      break;
    }
    if (typeof data?.data?.total === 'number' && data.data.total > 0) total = data.data.total;
    for (const row of diff) {
      const code = toStr(row.f12);
      const name = toStr(row.f14);
      if (!code || !name || seen.has(code)) continue;
      const symbol = memberCodeToSymbol(code);
      if (!symbol) continue; // 北交所跳過
      seen.add(code);
      out.push({ code, name, symbol, pct: toNum(row.f3) ?? 0, turnoverCny: toNum(row.f6) });
    }
    if (diff.length < PAGE_SIZE) break;
  }
  return out;
}
