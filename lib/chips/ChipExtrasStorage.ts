/**
 * 籌碼補充資料持久化層（融資券 / 借券 / 當沖；2026-06-12 B2）
 *
 * 路徑（per-stock，與 ChipStorage 同款 merge-by-date pattern）：
 *   data/chips/TW/margin/{code}.json     融資融券（TWSE MI_MARGN + TPEx margin_bal）
 *   data/chips/TW/sbl/{code}.json        借券/融券總量（TWSE TWT93U + TPEx sbl）
 *   data/chips/TW/daytrade/{code}.json   個股當沖（TWSE TWTB4U；上櫃無個股表 = v1 缺口）
 *
 * 為什麼要持久化（原本 /api/chip 是動態查官方 + FinMind fallback）：
 * 沒有本地歷史序列就做不了「融資暴增」「借券暴增」「當沖過高」的時間序判斷，
 * 也無法回測這些排除型訊號。寫入 cron：/api/cron/fetch-chip-extras（21:35 CST）。
 *
 * 獨立成檔不併入 ChipStorage.ts：避免與 instDerived（B3）改動衝突，且資料生命週期
 * 不同（這裡是 bulk cron 寫入，ChipStorage 是 lazy per-stock fetch）。
 *
 * 相容性：margin/ 與 sbl/ 既有檔案由 lib/squeeze/dataLoader.ts（FinMind lazy fetch）寫入，
 * 信封格式（symbol/market/lastDate/updatedAt/data）與 MarginDay 欄位完全相同；
 * 本檔 SblDay 是其超集（多 lendingShortSales/shortBalance/shortNet），merge 時舊列保留原樣，
 * 讀取端需容忍欄位缺漏。daytrade/ 是本檔新開目錄。
 */

import { promises as fs } from 'fs';
import path from 'path';

const ROOT = path.join(process.cwd(), 'data', 'chips', 'TW');
const MARGIN_DIR = path.join(ROOT, 'margin');
const SBL_DIR = path.join(ROOT, 'sbl');
const DAYTRADE_DIR = path.join(ROOT, 'daytrade');

export interface MarginDay {
  date: string;
  /** 融資餘額（張） */ marginBalance: number;
  /** 融資增減（張） */ marginNet: number;
  /** 融資使用率（%） */ marginUtilRate: number;
  /** 融券餘額（張） */ shortBalance: number;
  /** 融券增減（張） */ shortNet: number;
}

export interface SblDay {
  date: string;
  /** 借券餘額（張） */ lendingBalance: number;
  /** 借券淨變化（張） */ lendingNet: number;
  /** 借券當日新增放空（張） */ lendingShortSales: number;
  /** 融券餘額（張，總量管制表口徑） */ shortBalance: number;
  /** 融券淨變化（張） */ shortNet: number;
}

export interface DayTradeDay {
  date: string;
  /** 當沖成交量（張） */ dayTradeLots: number;
  /** 當沖買進金額（元） */ buyValue: number;
  /** 當沖賣出金額（元） */ sellValue: number;
}

interface ExtrasFile<T> {
  symbol: string;
  market: 'TW';
  lastDate: string;
  updatedAt: string;
  data: T[];
}

async function readExtras<T extends { date: string }>(dir: string, code: string): Promise<ExtrasFile<T> | null> {
  try {
    const raw = await fs.readFile(path.join(dir, `${code}.json`), 'utf8');
    return JSON.parse(raw) as ExtrasFile<T>;
  } catch {
    return null;
  }
}

async function writeExtras<T extends { date: string }>(
  dir: string,
  code: string,
  newRows: T[],
): Promise<{ added: boolean }> {
  const existing = await readExtras<T>(dir, code);
  const map = new Map<string, T>();
  for (const r of existing?.data ?? []) map.set(r.date, r);
  let added = false;
  for (const r of newRows) {
    const prev = map.get(r.date);
    if (!prev || JSON.stringify(prev) !== JSON.stringify(r)) added = true;
    map.set(r.date, r); // 後者覆蓋
  }
  if (!added) return { added: false }; // 內容沒變不重寫，避免 data/ churn
  const merged = Array.from(map.values()).sort((a, b) => a.date.localeCompare(b.date));
  const file: ExtrasFile<T> = {
    symbol: code,
    market: 'TW',
    lastDate: merged[merged.length - 1]?.date ?? '',
    updatedAt: new Date().toISOString(),
    data: merged,
  };
  const { atomicFsPut } = await import('@/lib/storage/atomicFsPut');
  await fs.mkdir(dir, { recursive: true });
  await atomicFsPut(path.join(dir, `${code}.json`), JSON.stringify(file));
  return { added: true };
}

export const readMarginStock = (code: string) => readExtras<MarginDay>(MARGIN_DIR, code);
export const writeMarginStock = (code: string, rows: MarginDay[]) => writeExtras(MARGIN_DIR, code, rows);

export const readSblStock = (code: string) => readExtras<SblDay>(SBL_DIR, code);
export const writeSblStock = (code: string, rows: SblDay[]) => writeExtras(SBL_DIR, code, rows);

export const readDayTradeStock = (code: string) => readExtras<DayTradeDay>(DAYTRADE_DIR, code);
export const writeDayTradeStock = (code: string, rows: DayTradeDay[]) => writeExtras(DAYTRADE_DIR, code, rows);
