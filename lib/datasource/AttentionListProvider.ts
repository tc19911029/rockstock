/**
 * 處置股/注意股官方名單 Provider（2026-06-12 B1）
 *
 * 來源（全部官方 OpenAPI、免費 JSON、單次回全市場，零額度問題）：
 *   - TWSE 處置：https://openapi.twse.com.tw/v1/announcement/punish
 *   - TWSE 注意：https://openapi.twse.com.tw/v1/announcement/notice（當日公布，無資料時回 placeholder 空列）
 *   - TPEx 處置：https://www.tpex.org.tw/openapi/v1/tpex_disposal_information
 *   - TPEx 注意：https://www.tpex.org.tw/openapi/v1/tpex_trading_warning_information
 *
 * 注意：
 *   - punish 清單混雜大量權證（6 碼，如 050503 緯穎中信5A購05），必須過濾只留個股/ETF
 *   - 日期全是民國年：Date="1150601"、TWSE 期間="115/06/02～115/06/15"（全形～）、
 *     TPEx 期間="1150615~1150629"
 *   - 處置期間常是「公布日之後」的未來區間，讀取端必須按日判斷是否落在期間內
 */
import { fetchJsonWithCurlFallback } from './curlFetch';

const TWSE_PUNISH_URL = 'https://openapi.twse.com.tw/v1/announcement/punish';
const TWSE_NOTICE_URL = 'https://openapi.twse.com.tw/v1/announcement/notice';
const TPEX_DISPOSAL_URL = 'https://www.tpex.org.tw/openapi/v1/tpex_disposal_information';
const TPEX_NOTICE_URL = 'https://www.tpex.org.tw/openapi/v1/tpex_trading_warning_information';

export interface AttentionEntry {
  /** 裸代號（4402，無 .TWO 後綴） */
  code: string;
  name: string;
  exchange: 'TWSE' | 'TPEX';
  kind: 'disposal' | 'notice';
  /** 公告日 YYYY-MM-DD */
  announceDate: string;
  /** 處置期間（disposal 限定）YYYY-MM-DD */
  periodStart?: string;
  periodEnd?: string;
  reason?: string;
  /** 第幾次處置 */
  measures?: string;
}

interface TwsePunishRow {
  Number: string;
  Date: string;                 // "1150601"
  Code: string;
  Name: string;
  ReasonsOfDisposition?: string;
  DispositionPeriod?: string;   // "115/06/02～115/06/15"
  DispositionMeasures?: string; // "第一次處置"
}

interface TwseNoticeRow {
  Number: string;
  Code: string;
  Name: string;
  TradingInfoForAttention?: string;
  Date: string;                 // "1150611"
}

interface TpexDisposalRow {
  Date: string;                   // "1150612"
  SecuritiesCompanyCode: string;  // "4402"
  CompanyName: string;
  DispositionPeriod?: string;     // "1150615~1150629"
  DispositionReasons?: string;
}

interface TpexNoticeRow {
  Date: string;                    // "1150814"
  SecuritiesCompanyCode: string;  // "3490"
  CompanyName: string;
  TradingInformation?: string;
}

/** 個股 4 碼、ETF/ETN 00 開頭 5-6 碼（可帶 L/R/U 等字尾）；權證 6 碼（050503）剔除 */
function isStockOrEtfCode(code: string): boolean {
  return /^\d{4}$/.test(code) || /^00\d{2,4}[A-Z]?$/.test(code);
}

/** 民國日期 → ISO。支援 "1150601" 與 "115/06/02" 兩種格式，無效回 null */
function rocToIso(token: string): string | null {
  const m = token.match(/^(\d{3})[/]?(\d{2})[/]?(\d{2})$/);
  if (!m) return null;
  const year = parseInt(m[1], 10) + 1911;
  const month = m[2];
  const day = m[3];
  if (year < 2000 || year > 2100) return null;
  return `${year}-${month}-${day}`;
}

/** 從期間字串抽 [start, end]（兩種官方格式 + 全形～），抽不到回 null */
function parsePeriod(raw: string | undefined): { start: string; end: string } | null {
  if (!raw) return null;
  const tokens = raw.match(/\d{3}\/\d{2}\/\d{2}|\d{7}/g);
  if (!tokens || tokens.length < 2) return null;
  const start = rocToIso(tokens[0]);
  const end = rocToIso(tokens[1]);
  if (!start || !end) return null;
  return { start, end };
}

export async function fetchTwsePunish(): Promise<AttentionEntry[]> {
  const { data } = await fetchJsonWithCurlFallback<TwsePunishRow[]>(TWSE_PUNISH_URL);
  if (!Array.isArray(data)) return [];
  const out: AttentionEntry[] = [];
  for (const row of data) {
    const code = (row.Code ?? '').trim();
    if (!isStockOrEtfCode(code)) continue; // 權證/placeholder 剔除
    const period = parsePeriod(row.DispositionPeriod);
    if (!period) continue; // 沒期間就無法做按日 veto，丟掉（實測每列都有）
    out.push({
      code,
      name: (row.Name ?? '').trim(),
      exchange: 'TWSE',
      kind: 'disposal',
      announceDate: rocToIso(row.Date) ?? period.start,
      periodStart: period.start,
      periodEnd: period.end,
      reason: row.ReasonsOfDisposition?.trim(),
      measures: row.DispositionMeasures?.trim(),
    });
  }
  return out;
}

export async function fetchTwseNotice(): Promise<AttentionEntry[]> {
  const { data } = await fetchJsonWithCurlFallback<TwseNoticeRow[]>(TWSE_NOTICE_URL);
  if (!Array.isArray(data)) return [];
  const out: AttentionEntry[] = [];
  for (const row of data) {
    const code = (row.Code ?? '').trim();
    if (!isStockOrEtfCode(code)) continue; // 無資料日的 placeholder（Code=""）也在此剔除
    const announceDate = rocToIso((row.Date ?? '').trim());
    if (!announceDate) continue;
    out.push({
      code,
      name: (row.Name ?? '').trim(),
      exchange: 'TWSE',
      kind: 'notice',
      announceDate,
      reason: row.TradingInfoForAttention?.trim(),
    });
  }
  return out;
}

export async function fetchTpexDisposal(): Promise<AttentionEntry[]> {
  const { data } = await fetchJsonWithCurlFallback<TpexDisposalRow[]>(TPEX_DISPOSAL_URL);
  if (!Array.isArray(data)) return [];
  const out: AttentionEntry[] = [];
  for (const row of data) {
    const code = (row.SecuritiesCompanyCode ?? '').trim();
    if (!isStockOrEtfCode(code)) continue;
    const period = parsePeriod(row.DispositionPeriod);
    if (!period) continue;
    out.push({
      code,
      name: (row.CompanyName ?? '').trim(),
      exchange: 'TPEX',
      kind: 'disposal',
      announceDate: rocToIso(row.Date) ?? period.start,
      periodStart: period.start,
      periodEnd: period.end,
      reason: row.DispositionReasons?.trim(),
    });
  }
  return out;
}

/** 上櫃注意股（只警示、不作處置硬排除）。 */
export async function fetchTpexNotice(): Promise<AttentionEntry[]> {
  const { data } = await fetchJsonWithCurlFallback<TpexNoticeRow[]>(TPEX_NOTICE_URL);
  return parseTpexNoticeRows(data);
}

/** 純解析器：官方清單混有權證，僅保留股票／ETF。 */
export function parseTpexNoticeRows(data: TpexNoticeRow[] | unknown): AttentionEntry[] {
  if (!Array.isArray(data)) return [];
  const out: AttentionEntry[] = [];
  for (const row of data as TpexNoticeRow[]) {
    const code = (row.SecuritiesCompanyCode ?? '').trim();
    if (!isStockOrEtfCode(code)) continue;
    const announceDate = rocToIso((row.Date ?? '').trim());
    if (!announceDate) continue;
    out.push({
      code,
      name: (row.CompanyName ?? '').trim(),
      exchange: 'TPEX',
      kind: 'notice',
      announceDate,
      reason: row.TradingInformation?.trim(),
    });
  }
  return out;
}
