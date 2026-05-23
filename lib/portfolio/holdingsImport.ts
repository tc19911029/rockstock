/**
 * Holdings 批量匯入（Phase 0.2）
 *
 * 設計目標：使用者從券商 app / 對帳單匯出 CSV，一鍵把實際持股寫進 holdings.json。
 *
 * CSV 規格（最小欄位 + 可選欄位）：
 *   必填：symbol, name, shares, avgCost
 *   選填：entryDate（預設 today CST）, stopLoss（預設 avgCost × 0.93）,
 *         target1, target2, industry, notes
 *
 * 範例：
 *   symbol,name,shares,avgCost,entryDate,stopLoss,target1,notes
 *   3037.TW,欣興,30,856.5,2026-04-15,800,1050,AI PCB
 *   2330.TW,台積電,5,1100,2026-03-10,1020,,
 *
 * 行為：
 *   - 解析 → 跑 entryPrice 驗證（除非 forcePrice=true）→ batch upsertHolding
 *   - 個別 row 失敗不擋其他 row；回傳 perRow 結果讓使用者修正後重跑
 *   - 不刪除既有 holdings（要重置請先 hard delete 或編輯 holdings.json）
 */

import { classifyMarket } from '@/lib/market/classify';
import type { PortfolioHolding } from '@/lib/agents/portfolio/types';
import { PORTFOLIO_SCHEMA_VERSION } from '@/lib/agents/portfolio/types';

export const STOP_LOSS_DEFAULT_PCT = 0.07; // 書本 7% 停損

export interface ImportRow {
  symbol: string;
  name: string;
  shares: number;
  avgCost: number;
  entryDate?: string;
  stopLoss?: number;
  target1?: number;
  target2?: number;
  industry?: string;
  notes?: string;
}

export interface ParsedImportRow {
  ok: boolean;
  rowNumber: number;             // 1-indexed (header = 0)
  raw: Record<string, string>;
  row?: ImportRow;
  reason?: string;
}

const REQUIRED_HEADERS = ['symbol', 'name', 'shares', 'avgCost'] as const;
const OPTIONAL_HEADERS = ['entryDate', 'stopLoss', 'target1', 'target2', 'industry', 'notes'] as const;
const ALL_HEADERS = [...REQUIRED_HEADERS, ...OPTIONAL_HEADERS];

/**
 * 輕量 CSV 解析（不引第三方）
 *   - 支援雙引號包裹欄位
 *   - 支援 "" 跳脫
 *   - 不處理跨行 quoted field（持股 CSV 不會出現）
 *   - BOM 自動去除
 *   - 行結尾 \r 自動去除
 */
export function parseCsv(text: string): { headers: string[]; rows: string[][] } {
  // 去 BOM
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const lines = text.split('\n').map(l => l.replace(/\r$/, '')).filter(l => l.trim());
  if (lines.length === 0) return { headers: [], rows: [] };

  const parseLine = (line: string): string[] => {
    const out: string[] = [];
    let i = 0;
    let cur = '';
    let inQuotes = false;
    while (i < line.length) {
      const ch = line[i];
      if (inQuotes) {
        if (ch === '"') {
          if (line[i + 1] === '"') { cur += '"'; i += 2; continue; }
          inQuotes = false; i++; continue;
        }
        cur += ch; i++;
      } else {
        if (ch === ',') { out.push(cur); cur = ''; i++; continue; }
        if (ch === '"' && cur === '') { inQuotes = true; i++; continue; }
        cur += ch; i++;
      }
    }
    out.push(cur);
    return out.map(s => s.trim());
  };

  const headers = parseLine(lines[0]);
  const rows = lines.slice(1).map(parseLine);
  return { headers, rows };
}

/** 驗證 header 至少含 REQUIRED_HEADERS（順序不限、可有額外欄位）*/
export function validateHeaders(headers: readonly string[]): { ok: boolean; reason?: string } {
  const set = new Set(headers);
  for (const req of REQUIRED_HEADERS) {
    if (!set.has(req)) return { ok: false, reason: `缺欄位 ${req}` };
  }
  return { ok: true };
}

function num(v: string | undefined): number | undefined {
  if (v == null || v.trim() === '') return undefined;
  const n = Number(v);
  if (!Number.isFinite(n)) return NaN;
  return n;
}

/** 把單 row 的 raw 字串對應成 ImportRow（含基本型別驗證）*/
export function parseRow(
  raw: Record<string, string>,
  rowNumber: number,
): ParsedImportRow {
  const symbol = (raw.symbol ?? '').trim();
  const name = (raw.name ?? '').trim();
  if (!symbol) return { ok: false, rowNumber, raw, reason: 'symbol 為空' };
  if (!name) return { ok: false, rowNumber, raw, reason: 'name 為空' };
  if (!/^[A-Za-z0-9._-]+$/.test(symbol)) {
    return { ok: false, rowNumber, raw, reason: `symbol 格式不合 (${symbol})` };
  }

  const shares = num(raw.shares);
  if (shares == null || Number.isNaN(shares) || shares <= 0 || !Number.isInteger(shares)) {
    return { ok: false, rowNumber, raw, reason: `shares 必須為正整數 (got ${raw.shares})` };
  }
  const avgCost = num(raw.avgCost);
  if (avgCost == null || Number.isNaN(avgCost) || avgCost <= 0) {
    return { ok: false, rowNumber, raw, reason: `avgCost 必須為正數 (got ${raw.avgCost})` };
  }

  const stopLoss = num(raw.stopLoss);
  const target1 = num(raw.target1);
  const target2 = num(raw.target2);
  if (stopLoss !== undefined && (Number.isNaN(stopLoss) || stopLoss <= 0)) {
    return { ok: false, rowNumber, raw, reason: `stopLoss 必須為正數` };
  }
  if (target1 !== undefined && (Number.isNaN(target1) || target1 <= 0)) {
    return { ok: false, rowNumber, raw, reason: `target1 必須為正數` };
  }
  if (target2 !== undefined && (Number.isNaN(target2) || target2 <= 0)) {
    return { ok: false, rowNumber, raw, reason: `target2 必須為正數` };
  }

  const entryDate = (raw.entryDate ?? '').trim();
  if (entryDate && !/^\d{4}-\d{2}-\d{2}$/.test(entryDate)) {
    return { ok: false, rowNumber, raw, reason: `entryDate 格式錯，應為 YYYY-MM-DD (got ${entryDate})` };
  }

  return {
    ok: true,
    rowNumber,
    raw,
    row: {
      symbol,
      name,
      shares,
      avgCost,
      ...(entryDate ? { entryDate } : {}),
      ...(stopLoss !== undefined ? { stopLoss } : {}),
      ...(target1 !== undefined ? { target1 } : {}),
      ...(target2 !== undefined ? { target2 } : {}),
      ...((raw.industry ?? '').trim() ? { industry: raw.industry.trim() } : {}),
      ...((raw.notes ?? '').trim() ? { notes: raw.notes.trim() } : {}),
    },
  };
}

/** 解析整份 CSV 文字 → ParsedImportRow[]（不寫檔，純函式）*/
export function parseImportCsv(text: string): {
  ok: boolean;
  reason?: string;
  parsed: ParsedImportRow[];
} {
  const { headers, rows } = parseCsv(text);
  const h = validateHeaders(headers);
  if (!h.ok) return { ok: false, reason: h.reason, parsed: [] };

  const parsed: ParsedImportRow[] = rows.map((cells, idx) => {
    const raw: Record<string, string> = {};
    headers.forEach((col, i) => { raw[col] = cells[i] ?? ''; });
    return parseRow(raw, idx + 1);
  });
  return { ok: true, parsed };
}

/** 依 ImportRow 推導 holding 各欄位的最終值（套用預設）*/
export function applyDefaults(
  row: ImportRow,
  todayDate: string,
): Omit<PortfolioHolding, 'createdAt' | 'updatedAt' | 'schemaVersion'> {
  const market = classifyMarket(row.symbol);
  if (market !== 'TW' && market !== 'CN') {
    throw new Error(`symbol ${row.symbol} 無法分類市場 (only TW/CN)`);
  }
  return {
    symbol: row.symbol,
    name: row.name,
    market,
    industry: row.industry,
    entryDate: row.entryDate ?? todayDate,
    entryPrice: row.avgCost,
    shares: row.shares,
    stopLoss: row.stopLoss ?? +(row.avgCost * (1 - STOP_LOSS_DEFAULT_PCT)).toFixed(2),
    target1: row.target1,
    target2: row.target2,
    notes: row.notes,
    status: 'open',
  };
}

/** Export schema version for tests / contract */
export const HOLDINGS_IMPORT_SCHEMA = {
  required: REQUIRED_HEADERS,
  optional: OPTIONAL_HEADERS,
  all: ALL_HEADERS,
  stopLossDefaultPct: STOP_LOSS_DEFAULT_PCT,
  schemaVersion: PORTFOLIO_SCHEMA_VERSION,
} as const;
