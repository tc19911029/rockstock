/**
 * MOPS 稀釋公告爬蟲 — 從 TWSE OpenAPI 抓「公司重大訊息」，
 * filter 主旨含 GDR/現金增資/可轉換公司債/員工認股權/私募，落地 data/dilution/{stockId}.json
 *
 * TODO（2026-05-27 MVP）：t187ap36_L 實際是「權證發行清單」不是重大訊息。
 *   正確 endpoint 在 mopsov（HTML parsing）：
 *     - 每日列表：https://mopsov.twse.com.tw/mops/web/ajax_t05sr01_1 (POST yymmdd)
 *     - 公司歷史：https://mopsov.twse.com.tw/mops/web/ajax_t05st01 (POST co_id+year)
 *   現在的 fetchOpenApi 對 3661 會 scanned 5 萬筆但 matched 0（因為主旨欄位不存在）。
 *   MVP 階段：data/dilution/{symbol}.json 可手動維護（見 3661 範例）；
 *   下一階段：把 fetchOpenApi 換成 mopsov HTML scraping。
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { atomicFsPut } from '@/lib/storage/atomicFsPut';

const TWSE_OPENAPI = 'https://openapi.twse.com.tw/v1/opendata/t187ap36_L';
const TPEX_OPENAPI = 'https://openapi.tpex.org.tw/v1/opendata/t187ap36_O';

interface MopsRawRow {
  公司代號?: string;
  公司簡稱?: string;
  發言日期?: string;
  發言時間?: string;
  主旨?: string;
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
}

const KEYWORD_MAP: Array<{ pattern: RegExp; type: DilutionType }> = [
  { pattern: /海外.*存託憑證|GDR|ADR/i, type: 'gdr' },
  { pattern: /現金增資/, type: 'rights_issue' },
  { pattern: /可轉換公司債|海外可轉換/, type: 'convertible_bond' },
  { pattern: /員工認股權|庫藏股轉讓予員工|限制員工權利新股/, type: 'employee_option' },
  { pattern: /私募/, type: 'private_placement' },
];

function classify(subject: string): DilutionType | null {
  for (const k of KEYWORD_MAP) {
    if (k.pattern.test(subject)) return k.type;
  }
  return null;
}

/**
 * 從主旨/說明文字中粗略解析新增股數（萬股 / 仟股 / 股）。
 * 解析不到就回 0 — UI 會標「待人工確認」。
 */
function parseNewShares(text: string): number {
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
  try {
    const r = await fetch(url, {
      signal: AbortSignal.timeout(15000),
      headers: { Accept: 'application/json' },
      cache: 'no-store',
    });
    if (!r.ok) return [];
    const json = await r.json();
    return Array.isArray(json) ? json : [];
  } catch {
    return [];
  }
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
    fetchOpenApi(TWSE_OPENAPI).catch((e) => { errors.push(`twse: ${e}`); return []; }),
    fetchOpenApi(TPEX_OPENAPI).catch((e) => { errors.push(`tpex: ${e}`); return []; }),
  ]);

  const allRows = [...twse, ...tpex];
  const bySymbol: Record<string, DilutionEntry[]> = {};
  let matched = 0;

  for (const row of allRows) {
    const code = String(row.公司代號 ?? '').trim();
    const subject = String(row.主旨 ?? '').trim();
    const description = String(row.說明 ?? '').trim();
    const announcedDateRoc = String(row.發言日期 ?? '').trim();
    if (!code || !subject) continue;

    const type = classify(subject + '\n' + description);
    if (!type) continue;
    matched++;

    const newShares = parseNewShares(subject + ' ' + description);
    const announcedAt = announcedDateRoc ? rocToIso(announcedDateRoc) : '';
    const sourceUrl = `https://mops.twse.com.tw/mops/web/t05st01?co_id=${code}`;

    const entry: DilutionEntry = {
      type,
      newShares,
      sourceUrl,
      announcedAt,
      description: subject + (description ? ' / ' + description.slice(0, 200) : ''),
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

      const seen = new Set(existing.map((e) => `${e.announcedAt}|${e.type}|${e.newShares}`));
      const merged = [...existing];
      for (const e of entries) {
        const key = `${e.announcedAt}|${e.type}|${e.newShares}`;
        if (!seen.has(key)) { merged.push(e); seen.add(key); }
      }
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
