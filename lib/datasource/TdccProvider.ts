/**
 * 集保戶股權分散表 Provider
 *
 * Endpoint: https://smart.tdcc.com.tw/opendata/getOD.ashx?id=1-5
 *
 * CSV 格式（big5 編碼，但伺服器以 utf-8 提供）:
 *   資料日期, 證券代號, 持股分級, 人數, 股數, 占集保庫存數比例%
 *   - 持股分級 1~17 共 17 級
 *   - 1: 1-999 股（零股），... 11: 200,001-400,000，12: 400,001-600,000
 *   - 13: 600,001-800,000，14: 800,001-1,000,000，15: 1,000,001 股以上
 *   - 16: 差異數（誤差調整），17: 合計
 *
 * 大戶定義：
 *   - 400 張↑ = 級 12+13+14+15 之比例合計（1張 = 1000股，400張 = 400,000股）
 *   - 1000 張↑ = 級 15 之比例（1,000,001 股以上）
 *
 * 此端點只回傳「最新一週」（每週四下午公布上週五持股）。
 * 歷史資料需要每週累積（cron 每週四抓一次）。
 */

import type { TdccDay } from '@/lib/chips/types';

const TDCC_URL = 'https://smart.tdcc.com.tw/opendata/getOD.ashx?id=1-5';

interface TdccLatestWeek {
  /** 資料基準日（週五），'YYYY-MM-DD' */
  date: string;
  /** key = pure code, e.g. '2330' */
  data: Map<string, TdccDay>;
}

/**
 * 抓取最新一週全市場大戶持股分散。
 * @param timeoutMs 預設 5 分鐘（CSV 約 2.3 MB，CN 直連特別慢）
 */
export async function fetchTdccLatestWeek(timeoutMs = 300000): Promise<TdccLatestWeek> {
  const res = await fetch(TDCC_URL, {
    signal: AbortSignal.timeout(timeoutMs),
    headers: {
      'Accept': 'text/csv,*/*',
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
    },
  });
  if (!res.ok) throw new Error(`TDCC HTTP ${res.status}`);
  const csv = await res.text();
  return parseTdccCsv(csv);
}

/** 解析 TDCC CSV 為 per-stock 大戶比例 */
export function parseTdccCsv(csv: string): TdccLatestWeek {
  const lines = csv.split(/\r?\n/);
  if (lines.length < 2) throw new Error('TDCC CSV 為空');

  // 累積 per-stock 各級比例
  // brackets[code] = { 12: pct, 13: pct, 14: pct, 15: pct, holderCount?: 合計人數 }
  const acc = new Map<string, { p12?: number; p13?: number; p14?: number; p15?: number; holders?: number }>();
  let headerDate = '';

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue;
    const cols = line.split(',');
    if (cols.length < 6) continue;
    const yyyymmdd = cols[0].trim();
    const code = cols[1].trim();
    const level = parseInt(cols[2], 10);
    const holders = parseInt(cols[3], 10) || 0;
    const pct = parseFloat(cols[5]) || 0;

    if (!/^\d{8}$/.test(yyyymmdd)) continue;
    if (!/^\d{4,6}$/.test(code)) continue;

    if (!headerDate) {
      headerDate = `${yyyymmdd.slice(0, 4)}-${yyyymmdd.slice(4, 6)}-${yyyymmdd.slice(6, 8)}`;
    }

    const cur = acc.get(code) ?? {};
    if (level === 12) cur.p12 = pct;
    else if (level === 13) cur.p13 = pct;
    else if (level === 14) cur.p14 = pct;
    else if (level === 15) cur.p15 = pct;
    else if (level === 17) cur.holders = holders; // 合計人數
    acc.set(code, cur);
  }

  // 組裝最終資料
  const data = new Map<string, TdccDay>();
  for (const [code, v] of acc) {
    const h400 = (v.p12 ?? 0) + (v.p13 ?? 0) + (v.p14 ?? 0) + (v.p15 ?? 0);
    const h1000 = v.p15 ?? 0;
    if (h400 === 0 && h1000 === 0 && !v.holders) continue; // 無資料的股票跳過
    data.set(code, {
      holder400Pct: +h400.toFixed(2),
      holder1000Pct: +h1000.toFixed(2),
      holderCount: v.holders,
    });
  }

  return { date: headerDate, data };
}
