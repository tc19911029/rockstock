/**
 * FinMind 券商分點日報 provider — 算「跟看盤 app 一樣」的主力籌碼集中度（取代 HiStock）
 *
 * 為什麼用 FinMind（2026-06-15 使用者提案）：
 *   - dataset `TaiwanStockTradingDailyReport` = 每檔每日「全部券商分點」買賣明細（~700-1500 筆/日，
 *     不像 HiStock 只露 top30、玩股網被 Cloudflare 擋）→ 區間排名精確、與 app 對得上。
 *   - **有「當天」資料**（盤後傍晚就出）→ 解決 HiStock/玩股網當日分點未出只能顯示「結算中」。
 *   - 會員層（2萬/hr）、官方權威源、本來就在用。
 *
 * 限制：此 dataset 一次只回「單日」（帶 end_date 會 400）→ 逐日抓、逐日快取、視窗在程式端彙總。
 * 集中度公式見 [lib/chips/chipConcentration.ts]。純顯示資料流，不改任何選股 gate。
 */
import { fetchJsonWithCurlFallback } from './curlFetch';

const FINMIND_URL = 'https://api.finmindtrade.com/api/v4/data';

interface FinMindResp {
  status?: number;
  msg?: string;
  data?: Array<{ securities_trader_id?: string; securities_trader?: string; buy: number; sell: number }>;
}

export type FinMindBranchStatusKind = 'unknown' | 'ok' | 'permission_denied' | 'rate_limited' | 'unavailable';
export interface FinMindBranchSourceStatus {
  kind: FinMindBranchStatusKind;
  message: string;
  checkedAt: string | null;
}

const PERMISSION_COOLDOWN_MS = 15 * 60_000;
let sourceStatus: FinMindBranchSourceStatus = {
  kind: 'unknown', message: '尚未檢查 FinMind 券商分點權限', checkedAt: null,
};
let permissionBlockedUntil = 0;

/** 純函式：讓 API 與測試以同一規則辨識永久權限錯誤，避免無效重試數十次。 */
export function classifyFinMindBranchResponse(resp: Pick<FinMindResp, 'status' | 'msg'> | null | undefined): FinMindBranchSourceStatus {
  const checkedAt = new Date().toISOString();
  if (resp?.status === 200) return { kind: 'ok', message: 'FinMind 券商分點資料可用', checkedAt };
  const msg = (resp?.msg ?? '').trim();
  if (/user level|update your user level|permission|權限|方案|會員等級/i.test(msg)) {
    return { kind: 'permission_denied', message: `FinMind 方案權限不足：${msg || '請升級會員方案'}`, checkedAt };
  }
  if (resp?.status === 402 || resp?.status === 429 || /rate.?limit|too many|流量|限流/i.test(msg)) {
    return { kind: 'rate_limited', message: msg || 'FinMind 暫時限流', checkedAt };
  }
  return { kind: 'unavailable', message: msg || `FinMind 回傳狀態 ${resp?.status ?? '未知'}`, checkedAt };
}

export function getFinMindBranchSourceStatus(): FinMindBranchSourceStatus {
  return { ...sourceStatus };
}

/**
 * 抓 FinMind 券商分點「單日」→ branchId → 當日淨買賣超(張)。
 * @param date YYYY-MM-DD。抓不到 / 限流(402) → 回空 Map（呼叫端不快取、下次重抓）。
 */
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function safeFinMindErrorMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  // curl/fetch 錯誤可能把完整 query 印出來；token 絕不可進 UI、log 或健康端點。
  return raw
    .replace(/([?&]token=)[^&\s)]+/gi, '$1[REDACTED]')
    .replace(/(Bearer\s+)[A-Za-z0-9._~-]+/gi, '$1[REDACTED]');
}

// ── 全域並發閘（2026-06-15）──────────────────────────────────────────────
// 掃描會從多檔股票同時呼叫 → 並發過高時 FinMind 大量非 200，strict 模式就把整票股票
// 誤略過（0 命中）。這個閘把「同時打 FinMind 的數量」全域壓在 MAX_CONCURRENT，無論幾個
// 呼叫端，確保每次請求都成功、結果穩定。
const MAX_CONCURRENT = 3;
let active = 0;
const waiters: Array<() => void> = [];
async function withLimit<T>(fn: () => Promise<T>): Promise<T> {
  if (active >= MAX_CONCURRENT) await new Promise<void>((r) => waiters.push(r));
  active++;
  try { return await fn(); }
  finally { active--; waiters.shift()?.(); }
}

export async function fetchFinMindBranchDay(code: string, date: string): Promise<Map<string, number>> {
  return withLimit(() => fetchFinMindBranchDayInner(code, date));
}

async function fetchFinMindBranchDayInner(code: string, date: string): Promise<Map<string, number>> {
  if (sourceStatus.kind === 'permission_denied' && Date.now() < permissionBlockedUntil) {
    return new Map();
  }
  const token = (process.env.FINMIND_API_TOKEN ?? '').trim();
  const url = `${FINMIND_URL}?dataset=TaiwanStockTradingDailyReport&data_id=${encodeURIComponent(code)}`
    + `&start_date=${date}${token ? `&token=${encodeURIComponent(token)}` : ''}`;
  const net = new Map<string, number>();
  // 並發過高時 FinMind 偶發非 200 → 短退避重試 2 次（避免「掃描時靜默退回舊公式」）。
  // status 200 但 data 空 = 該日該股真的沒分點 → 不重試、回空。
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      // FinMind 的業務錯誤（例如方案層級不足）會用 HTTP 400 + JSON msg 回傳。
      // 通用 curl helper 對 HTTP 400 使用 -f，會丟掉 JSON body，因此先直接解析 body，
      // 只有真正的網路／JSON 失敗才走 curl fallback。
      let resp: FinMindResp;
      try {
        const response = await fetch(url, {
          headers: { 'User-Agent': 'Rockstock/1.0' },
          signal: AbortSignal.timeout(10_000),
        });
        resp = await response.json() as FinMindResp;
      } catch {
        resp = (await fetchJsonWithCurlFallback<FinMindResp>(url, { timeoutMs: 25_000 })).data;
      }
      const classified = classifyFinMindBranchResponse(resp);
      sourceStatus = classified;
      if (classified.kind === 'ok') {
        for (const r of resp.data ?? []) {
          const k = r.securities_trader_id || r.securities_trader || '';
          if (!k) continue;
          net.set(k, (net.get(k) ?? 0) + (r.buy - r.sell) / 1000); // 股 → 張
        }
        return net;
      }
      // 會員方案不足是永久錯誤；再試 3 次、再抓 29 個日期都不會變成功。
      if (classified.kind === 'permission_denied') {
        permissionBlockedUntil = Date.now() + PERMISSION_COOLDOWN_MS;
        return net;
      }
      if (attempt < 2) await sleep(400 * (attempt + 1)); // 0.4s, 0.8s
    } catch (error) {
      sourceStatus = {
        kind: 'unavailable',
        message: `FinMind 連線失敗：${safeFinMindErrorMessage(error)}`,
        checkedAt: new Date().toISOString(),
      };
      if (attempt < 2) await sleep(400 * (attempt + 1));
    }
  }
  return net; // 重試後仍失敗 → 回空（呼叫端不快取、strict 模式會略過該股而非用錯數據）
}
