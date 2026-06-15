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

  // 累積 per-stock 全 15 級距明細（人數+比例）+ 合計人數。
  // level 1=1張以下(零股) … 9=50~100張、10=100~200、11=200-400、12=400-600、
  //       13=600-800、14=800-1000、15=1000 張↑、16=差異數(略)、17=合計
  const acc = new Map<string, {
    brackets: Array<{ level: number; holders: number; pct: number }>;
    holders?: number;
  }>();
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

    const cur = acc.get(code) ?? { brackets: [] };
    if (level >= 1 && level <= 15) cur.brackets.push({ level, holders, pct: +pct.toFixed(2) });
    else if (level === 17) cur.holders = holders; // 合計人數
    acc.set(code, cur);
  }

  // 組裝最終資料
  const data = new Map<string, TdccDay>();
  for (const [code, v] of acc) {
    const byLevel = new Map(v.brackets.map(b => [b.level, b.pct]));
    const p = (lv: number) => byLevel.get(lv) ?? 0;
    const p10 = p(10), p11 = p(11), p12 = p(12), p13 = p(13), p14 = p(14), p15 = p(15);
    const h100 = p10 + p11 + p12 + p13 + p14 + p15;
    const h200 = p11 + p12 + p13 + p14 + p15;
    const h400 = p12 + p13 + p14 + p15;
    const h1000 = p15;
    if (h100 === 0 && !v.holders) continue; // 無資料的股票跳過
    const brackets = v.brackets.length
      ? v.brackets.slice().sort((a, b) => a.level - b.level)
      : undefined;
    data.set(code, {
      holder100Pct: +h100.toFixed(2),
      holder200Pct: +h200.toFixed(2),
      holder400Pct: +h400.toFixed(2),
      holder1000Pct: +h1000.toFixed(2),
      holder400To600Pct: +p12.toFixed(2),
      holder600To800Pct: +p13.toFixed(2),
      holder800To1000Pct: +p14.toFixed(2),
      holderCount: v.holders,
      brackets,
    });
  }

  return { date: headerDate, data };
}
