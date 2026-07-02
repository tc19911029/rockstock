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

/**
 * 抓 FinMind 券商分點「單日」→ branchId → 當日淨買賣超(張)。
 * @param date YYYY-MM-DD。抓不到 / 限流(402) → 回空 Map（呼叫端不快取、下次重抓）。
 */
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

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
  const token = (process.env.FINMIND_API_TOKEN ?? '').trim();
  const url = `${FINMIND_URL}?dataset=TaiwanStockTradingDailyReport&data_id=${encodeURIComponent(code)}`
    + `&start_date=${date}${token ? `&token=${encodeURIComponent(token)}` : ''}`;
  const net = new Map<string, number>();
  // 並發過高時 FinMind 偶發非 200 → 短退避重試 2 次（避免「掃描時靜默退回舊公式」）。
  // status 200 但 data 空 = 該日該股真的沒分點 → 不重試、回空。
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const { data: resp } = await fetchJsonWithCurlFallback<FinMindResp>(url, { timeoutMs: 25_000 });
      if (resp?.status === 200) {
        for (const r of resp.data ?? []) {
          const k = r.securities_trader_id || r.securities_trader || '';
          if (!k) continue;
          net.set(k, (net.get(k) ?? 0) + (r.buy - r.sell) / 1000); // 股 → 張
        }
        return net;
      }
      if (attempt < 2) await sleep(400 * (attempt + 1)); // 0.4s, 0.8s
    } catch {
      if (attempt < 2) await sleep(400 * (attempt + 1));
    }
  }
  return net; // 重試後仍失敗 → 回空（呼叫端不快取、strict 模式會略過該股而非用錯數據）
}
