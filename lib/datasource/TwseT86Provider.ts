/**
 * 三大法人買賣超 Provider — 改用 FinMind 而非 TWSE T86
 *
 * FinMind dataset: TaiwanStockInstitutionalInvestorsBuySell
 * - 涵蓋上市+上櫃，欄位穩定
 * - 免費等級不支援全市場批次查詢，必須帶 data_id
 *
 * Endpoint:
 *   https://api.finmindtrade.com/api/v4/data
 *     ?dataset=TaiwanStockInstitutionalInvestorsBuySell
 *     &data_id={code}                # 個股查詢（必填，免費等級限制）
 *     &start_date=YYYY-MM-DD
 *     &end_date=YYYY-MM-DD
 *     &token={FINMIND_API_TOKEN}
 *
 * 回傳資料每列：
 *   { date, stock_id, name: 'Foreign_Investor'|'Foreign_Dealer_Self'|'Investment_Trust'|'Dealer_self'|'Dealer_Hedging',
 *     buy, sell }   ← 單位是「股」
 *
 * 一支股一日有 5 列（5 種法人）。
 */

import type { InstDay } from '@/lib/chips/types';

const FINMIND_API = 'https://api.finmindtrade.com/api/v4/data';

function getToken(): string {
  return process.env.FINMIND_API_TOKEN?.replace(/['"]/g, '').trim() ?? '';
}

interface FinmindRow {
  date: string;
  stock_id: string;
  buy: number;
  sell: number;
  name: 'Foreign_Investor' | 'Foreign_Dealer_Self' | 'Investment_Trust' | 'Dealer_self' | 'Dealer_Hedging' | string;
}

interface FinmindResponse {
  msg?: string;
  status?: number;
  data?: FinmindRow[];
}

/** 把 5 種法人原始 raw rows 合併成「每日一列」InstDay 結構 */
function mergeRows(rows: FinmindRow[]): Map<string, InstDay> {
  // map<date, {f,t,d}> in 股
  const byDate = new Map<string, { foreign: number; trust: number; dealer: number }>();
  for (const r of rows) {
    if (!r.date) continue;
    const net = (r.buy ?? 0) - (r.sell ?? 0);
    const cur = byDate.get(r.date) ?? { foreign: 0, trust: 0, dealer: 0 };
    switch (r.name) {
      case 'Foreign_Investor':
      case 'Foreign_Dealer_Self':
        cur.foreign += net; break;
      case 'Investment_Trust':
        cur.trust += net; break;
      case 'Dealer_self':
      case 'Dealer_Hedging':
        cur.dealer += net; break;
    }
    byDate.set(r.date, cur);
  }
  // 股 → 張
  const out = new Map<string, InstDay>();
  for (const [date, v] of byDate) {
    const f = Math.round(v.foreign / 1000);
    const t = Math.round(v.trust / 1000);
    const d = Math.round(v.dealer / 1000);
    out.set(date, { foreign: f, trust: t, dealer: d, total: f + t + d });
  }
  return out;
}

/**
 * 抓單一股票指定日期區間的法人買賣超。
 * @param code 純數字代碼（無 .TW/.TWO）
 * @returns Map<date, InstDay>（升冪 by date）
 */
export async function fetchT86ForStock(
  code: string,
  startDate: string,
  endDate: string,
): Promise<Map<string, InstDay>> {
  const token = getToken();
  if (!token) throw new Error('FINMIND_API_TOKEN 未設定');

  const url = `${FINMIND_API}?dataset=TaiwanStockInstitutionalInvestorsBuySell&data_id=${encodeURIComponent(code)}&start_date=${startDate}&end_date=${endDate}&token=${encodeURIComponent(token)}`;
  const res = await fetch(url, {
    signal: AbortSignal.timeout(30000),
    headers: { 'Accept': 'application/json' },
  });
  if (!res.ok) throw new Error(`FinMind T86 HTTP ${res.status} for ${code}`);
  const json = (await res.json()) as FinmindResponse;
  if (json.status !== 200) {
    throw new Error(`FinMind T86 status=${json.status} msg=${json.msg}`);
  }
  return mergeRows(json.data ?? []);
}
