/**
 * MOPS 稀釋公告爬蟲 — 從 TWSE/TPEx OpenAPI「每日重大訊息」抓公告，
 * filter 主旨含 GDR/現金增資/可轉換公司債/員工認股權/私募，落地 data/dilution/{stockId}.json
 *
 * 資料源（2026-06-12 修正 — 舊版誤用 t187ap36_L 權證發行清單，永遠 matched 0）：
 *   - 上市：https://openapi.twse.com.tw/v1/opendata/t187ap04_L（上市公司每日重大訊息）
 *   - 上櫃：https://www.tpex.org.tw/openapi/v1/mopsfin_t187ap04_O（上櫃公司每日重大訊息）
 *
 * 兩端欄位名不一致（實抓驗證過）：
 *   - TWSE：公司代號 / 公司名稱 / 主旨（⚠️ JSON key 是「主旨 」帶尾空格）
 *   - TPEx：SecuritiesCompanyCode / CompanyName / 主旨（無尾空格）
 *   共通欄：發言日期（民國 yyyMMdd）/ 發言時間 / 符合條款 / 事實發生日 / 說明
 *
 * 設計重點：
 *   1. OpenAPI 只有「當日出表」資料（內容是最近一個交易日的發言）— 所以走每日增量
 *      append，搭配 19:30 CST cron 一天累積一批，歷史靠日積月累。
 *   2. 分類只看「主旨」不看「說明」— 說明欄是 MOPS 樣板問答，股東常會決議/除息公告
 *      的樣板文字常順帶出現「私募」「員工認股權」字樣，掃說明會整片誤判（實抓驗證：
 *      單日 desc-only 誤中 20+ 筆 vs 主旨命中 14 筆全為真稀釋公告）。
 *   3. 主旨常被 MOPS 強制斷行（\r\n 插在詞中間，例：「可\r\n轉換公司債」），分類前
 *      必須先剝掉所有空白，否則關鍵字被斷行截斷會分錯類。
 *   4. TPEx 在 Cloudflare 後面，Node fetch 必擋 — 走 fetchJsonWithCurlFallback
 *      （對 tpex.org.tw 自動 curl-first + 本機代理 fallback）。
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { atomicFsPut } from '@/lib/storage/atomicFsPut';
import { fetchJsonWithCurlFallback } from '@/lib/datasource/curlFetch';

const TWSE_OPENAPI = 'https://openapi.twse.com.tw/v1/opendata/t187ap04_L';
const TPEX_OPENAPI = 'https://www.tpex.org.tw/openapi/v1/mopsfin_t187ap04_O';

interface MopsRawRow {
  /** TWSE 用 */
  公司代號?: string;
  公司名稱?: string;
  /** TPEx 用 */
  SecuritiesCompanyCode?: string;
  CompanyName?: string;
  /** 共通（民國 yyyMMdd） */
  發言日期?: string;
  發言時間?: string;
  主旨?: string;
  /** TWSE 的主旨 key 帶尾空格 — 用 index signature 讀 */
  符合條款?: string;
  事實發生日?: string;
  說明?: string;
  [k: string]: unknown;
}

export type DilutionType =
  | 'gdr'
  | 'rights_issue'
  | 'convertible_bond'
  | 'employee_option'
  | 'private_placement';

export interface DilutionEntry {
  type: DilutionType;
  newShares: number;
  expectedDate?: string;
  priceIfKnown?: number;
  sourceUrl: string;
  announcedAt: string;
  description: string;
  status?: 'pending' | 'approved' | 'completed' | 'cancelled';
}

// 順序有意義：一則公告可能同時命中多個關鍵字（例：「以私募方式辦理現金增資」），
// 取第一個命中 — 越前面的越能代表「稀釋的形式」（GDR > 現增 > CB > 員工認股 > 私募）
const KEYWORD_MAP: Array<{ pattern: RegExp; type: DilutionType }> = [
  { pattern: /海外.*存託憑證|GDR|ADR/i, type: 'gdr' },
  { pattern: /現金增資/, type: 'rights_issue' },
  { pattern: /可轉換公司債|海外可轉換/, type: 'convertible_bond' },
  { pattern: /員工認股權|限制員工權利新股/, type: 'employee_option' },
  { pattern: /私募/, type: 'private_placement' },
];

// 命中關鍵字但明顯不是「新的稀釋事件」的雜訊主旨 — 例：既發行 CB 觸及
// 注意交易/處置標準的市場監視公告（實抓踩到：49793 華星光三達公布注意交易資訊標準）
const NOISE_PATTERN = /注意交易資訊|處置(?:有價證券|股票|交易)|代重要子公司|代子公司|認購.*現金增資|取得.*私募|投資.*私募|調整.*轉換價格|轉換價格.*調整|減資|庫藏股註銷|洽特定人認購|催繳|延長募集期間/;
const CANCELLED_PATTERN = /不繼續辦理|撤銷|取消|終止辦理|停止辦理/;
const COMPLETED_PATTERN = /完成募集|完成訂價|完成定價|收足股款|發行新股變更登記完成|已完成/;
const APPROVED_PATTERN = /核准|申報生效|董事會決議|股東會決議/;

export function classifyDilutionSubject(subject: string): DilutionType | null {
  // 剝掉所有空白再比對 — MOPS 主旨會在詞中間強制斷行（\r\n），不剝會截斷關鍵字
  const flat = subject.replace(/\s+/g, '');
  if (NOISE_PATTERN.test(flat)) return null;
  for (const k of KEYWORD_MAP) {
    if (k.pattern.test(flat)) return k.type;
  }
  return null;
}

export function inferDilutionStatus(subject: string): DilutionEntry['status'] {
  const flat = subject.replace(/\s+/g, '');
  if (CANCELLED_PATTERN.test(flat)) return 'cancelled';
  if (COMPLETED_PATTERN.test(flat)) return 'completed';
  if (APPROVED_PATTERN.test(flat)) return 'approved';
  return 'pending';
}

/**
 * 從主旨/說明文字中粗略解析新增股數（萬股 / 仟股 / 股）。
 * 解析不到就回 0 — UI 會標「待人工確認」。
 */
export function parseNewShares(text: string): number {
  // 「不超過 600 萬股」「以 600,000 千股」「3,000,000 股」
  const wan = text.match(/(?:不超過|擬發行|預計發行)?[^\d]{0,5}([\d,.]+)\s*萬股/);
  if (wan) return Math.round(parseFloat(wan[1].replace(/,/g, '')) * 10000);
  const qian = text.match(/(?:不超過|擬發行|預計發行)?[^\d]{0,5}([\d,.]+)\s*[千仟]股/);
  if (qian) return Math.round(parseFloat(qian[1].replace(/,/g, '')) * 1000);
  const raw = text.match(/(?:不超過|擬發行|預計發行)?[^\d]{0,5}([\d,]+)\s*股/);
  if (raw) {
    const n = parseInt(raw[1].replace(/,/g, ''), 10);
    if (n > 1000) return n;
  }
  return 0;
}

/**
 * 民國 yyyMMdd → 西元 YYYY-MM-DD
 */
function rocToIso(roc: string): string {
  if (!/^\d{6,7}$/.test(roc)) return roc;
  const y = parseInt(roc.slice(0, roc.length - 4), 10) + 1911;
  const m = roc.slice(-4, -2);
  const d = roc.slice(-2);
  return `${y}-${m}-${d}`;
}

async function fetchOpenApi(url: string): Promise<MopsRawRow[]> {
  // fetchJsonWithCurlFallback：TWSE 走 Node fetch、TPEx 自動 curl-first（Cloudflare）
  const { data } = await fetchJsonWithCurlFallback<unknown>(url, {
    timeoutMs: 20000,
    headers: { Accept: 'application/json' },
  });
  return Array.isArray(data) ? (data as MopsRawRow[]) : [];
}

/** 兩端欄位名不同 → 統一抽出 code / subject（TWSE 主旨 key 帶尾空格） */
function extractRow(row: MopsRawRow): { code: string; subject: string } {
  const code = String(row.公司代號 ?? row.SecuritiesCompanyCode ?? '').trim();
  const subject = String(row.主旨 ?? row['主旨 '] ?? '').trim();
  return { code, subject };
}

export interface ScrapeResult {
  scanned: number;
  matched: number;
  written: number;
  bySymbol: Record<string, DilutionEntry[]>;
  errors: string[];
}

export async function scrapeMopsDilution(opts?: { dryRun?: boolean }): Promise<ScrapeResult> {
  const errors: string[] = [];
  const [twse, tpex] = await Promise.all([
    fetchOpenApi(TWSE_OPENAPI).catch((e) => { errors.push(`twse: ${e}`); return [] as MopsRawRow[]; }),
    fetchOpenApi(TPEX_OPENAPI).catch((e) => { errors.push(`tpex: ${e}`); return [] as MopsRawRow[]; }),
  ]);

  const allRows = [...twse, ...tpex];
  const bySymbol: Record<string, DilutionEntry[]> = {};
  let matched = 0;

  for (const row of allRows) {
    const { code, subject } = extractRow(row);
    const description = String(row.說明 ?? '').trim();
    const announcedDateRoc = String(row.發言日期 ?? '').trim();
    if (!/^\d{4,6}$/.test(code) || !subject) continue;

    const type = classifyDilutionSubject(subject);
    if (!type) continue;
    matched++;

    const newShares = parseNewShares(subject + ' ' + description);
    const announcedAt = announcedDateRoc ? rocToIso(announcedDateRoc) : '';
    const sourceUrl = `https://mops.twse.com.tw/mops/web/t05st01?co_id=${code}`;

    // 主旨的強制斷行壓成單行存（顯示用）
    const subjectFlat = subject.replace(/\s+/g, ' ');
    const entry: DilutionEntry = {
      type,
      newShares,
      sourceUrl,
      announcedAt,
      description: subjectFlat + (description ? ' / ' + description.replace(/\s+/g, ' ').slice(0, 200) : ''),
      status: inferDilutionStatus(subject),
    };

    bySymbol[code] ??= [];
    bySymbol[code].push(entry);
  }

  let written = 0;
  if (!opts?.dryRun) {
    const dilutionDir = path.join(process.cwd(), 'data', 'dilution');
    await fs.mkdir(dilutionDir, { recursive: true }).catch(() => {});

    for (const [code, entries] of Object.entries(bySymbol)) {
      const filePath = path.join(dilutionDir, `${code}.json`);
      let existing: DilutionEntry[] = [];
      try {
        const raw = await fs.readFile(filePath, 'utf-8');
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) existing = parsed;
      } catch { /* file missing OK */ }

      // 冪等：同一公司「同日 + 同類型」只留一筆（檔案本身就是 per-symbol，代號隱含）。
      // cron 一天可能重跑、或同公司同日對同件事連發補充公告（例：現增 → 補充發行價格），
      // 都視為同一事件不重複 append。
      const dedupKey = (e: DilutionEntry) => `${e.announcedAt}|${e.type}`;
      const seen = new Set(existing.map(dedupKey));
      const merged = [...existing];
      let added = 0;
      for (const e of entries) {
        const key = dedupKey(e);
        if (!seen.has(key)) { merged.push(e); seen.add(key); added++; }
      }
      if (added === 0) continue; // 沒新東西不重寫，避免 data/ 下無謂的檔案 churn

      // 依公告日期排序（新→舊）
      merged.sort((a, b) => (b.announcedAt || '').localeCompare(a.announcedAt || ''));

      try {
        await atomicFsPut(filePath, JSON.stringify(merged, null, 2));
        written++;
      } catch (e) {
        errors.push(`write ${code}: ${e}`);
      }
    }
  }

  return {
    scanned: allRows.length,
    matched,
    written,
    bySymbol,
    errors,
  };
}
