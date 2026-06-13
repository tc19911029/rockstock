/**
 * EM 人氣榜 provider — 東財個股人氣榜 top100（emappdata stockrank）
 *
 * 資料源：POST https://emappdata.eastmoney.com/stockrank/getAllCurrentList
 * 2026-06-12 curl -X POST 實測：回 { status:0, data:[{ sc:'SH603993', rk:1, ... }] }，
 * sc=市場前綴+6 位代碼（SH/SZ/BJ），rk=名次 1-based；rc/hisRc 為名次變化欄（此層不取，
 * rankYesterday/rankChange/daysInTop100 由組裝層讀前一日檔自算，單一事實一致）。
 *
 * POST 不能用 fetchJsonWithCurlFallback（GET 專用）→ 此檔自帶 POST 版兩段失敗鏈：
 *   1) Node fetch POST（快、不 spawn 子程序）
 *   2) execFile curl -X POST（仿 curlFetch.ts：-f -s -4 --max-time；
 *      -f 必帶，否則 4xx/5xx 的錯誤頁會被當成功進 JSON.parse）
 * 刻意不做代理輪替（emappdata 直連穩定度尚可）；兩段都失敗 → throw。
 *
 * akshare fallback 決議：不接（二選一裡選「EM 失敗直接 throw」）。理由：
 *   - akshare stock_hot_rank_em 底層打的就是同一個 emappdata 端點，備援價值趨近零
 *   - A 軌的 'hot_rank' bridge handler 尚未落地，貿然猜輸出欄位形狀有默默吃錯資料風險
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { CnAgentsDataSource } from '@/lib/cn-agents/types';

const execFileAsync = promisify(execFile);

const HOT_RANK_URL = 'https://emappdata.eastmoney.com/stockrank/getAllCurrentList';
/** EM app 固定 payload（globalId 為任意裝置識別字串，照抄即可） */
const HOT_RANK_BODY = {
  appId: 'appId01',
  globalId: '786e4c21-70dc-435a-93bb-38',
  marketType: '',
  pageNo: 1,
  pageSize: 100,
};
const TIMEOUT_MS = 15_000;
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

interface EmHotRankRow {
  sc?: unknown; // 'SH603993' 形式
  rk?: unknown; // 名次 1-based
}

interface EmHotRankResponse {
  status?: number;
  message?: string;
  data?: EmHotRankRow[] | null;
}

/** POST JSON，Node fetch 失敗走 curl -X POST；兩段都掛 throw 合併錯誤 */
async function postJsonWithCurlFallback<T>(url: string, body: unknown): Promise<T> {
  const payload = JSON.stringify(body);

  // ── 1) Node fetch POST ─────────────────────────────────────────────
  let fetchErr: unknown = null;
  try {
    const res = await fetch(url, {
      method: 'POST',
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: { 'Content-Type': 'application/json', 'User-Agent': UA },
      body: payload,
    });
    if (res.ok) return await res.json() as T;
    fetchErr = new Error(`HTTP ${res.status}`);
  } catch (err) {
    fetchErr = err;
  }

  // ── 2) curl -X POST fallback ──────────────────────────────────────
  try {
    const args = [
      '-f', '-s', '-4',
      '--max-time', String(Math.ceil(TIMEOUT_MS / 1000)),
      '-X', 'POST',
      '-H', 'Content-Type: application/json',
      '-H', `User-Agent: ${UA}`,
      '--data', payload,
      url,
    ];
    const { stdout } = await execFileAsync('curl', args, {
      encoding: 'utf-8',
      maxBuffer: 10 * 1024 * 1024,
    });
    if (!stdout) throw new Error('curl returned empty stdout');
    return JSON.parse(stdout) as T;
  } catch (curlErr) {
    const fMsg = fetchErr instanceof Error ? fetchErr.message : String(fetchErr);
    const cMsg = curlErr instanceof Error ? curlErr.message : String(curlErr);
    throw new Error(`hot rank POST failed (fetch: ${fMsg}); curl fallback also failed (${cMsg})`);
  }
}

/** 'SH603993' / 'SZ000001' / 'BJ832566' → 6 位裸碼；格式不符回 null */
function parseBareSymbol(sc: unknown): string | null {
  if (typeof sc !== 'string') return null;
  const bare = sc.replace(/^[A-Z]+/, '');
  return /^\d{6}$/.test(bare) ? bare : null;
}

/**
 * 抓東財人氣榜 top100，剝市場前綴回 6 位裸碼 + 1-based 名次（升冪）。
 * rankYesterday/rankChange/daysInTop100 等跨日欄由組裝層補。失敗 throw。
 */
export async function fetchEmHotRankTop100(): Promise<{
  entries: Array<{ symbol: string; rank: number }>;
  source: CnAgentsDataSource;
}> {
  const res = await postJsonWithCurlFallback<EmHotRankResponse>(HOT_RANK_URL, HOT_RANK_BODY);
  if (!Array.isArray(res?.data) || res.data.length === 0) {
    throw new Error(`EM hot rank 無資料（status=${res?.status} message=${res?.message ?? ''}）`);
  }

  const seen = new Set<string>();
  const entries: Array<{ symbol: string; rank: number }> = [];
  for (const row of res.data) {
    const symbol = parseBareSymbol(row.sc);
    const rank = typeof row.rk === 'number' && Number.isFinite(row.rk) ? row.rk : null;
    if (!symbol || rank === null || seen.has(symbol)) continue;
    seen.add(symbol);
    entries.push({ symbol, rank });
  }
  if (entries.length === 0) throw new Error('EM hot rank 全列解析失敗（sc/rk 欄位結構可能變更）');

  entries.sort((a, b) => a.rank - b.rank);
  return { entries, source: 'em-push2ex' };
}
