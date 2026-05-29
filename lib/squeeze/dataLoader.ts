/**
 * 軋空模組的資料層 —— range fetch + 本地 cache（incremental merge）
 *
 * 快取路徑：
 *   data/chips/TW/margin/{code}.json    融資融券時序
 *   data/chips/TW/sbl/{code}.json       借券賣出時序
 *
 * 價格 / VWAP 直接讀 data/candles/TW/{code}.TW.json 的 close（保底），
 * 並從 FinMind TaiwanStockPrice 補成交金額算 VWAP（精準版）。
 */

import { promises as fs } from 'fs';
import path from 'path';
import type { MarginDay, SblDay, PriceDay } from './types';

const FINMIND_API = 'https://api.finmindtrade.com/api/v4/data';
const ROOT = path.join(process.cwd(), 'data', 'chips', 'TW');
const MARGIN_DIR = path.join(ROOT, 'margin');
const SBL_DIR = path.join(ROOT, 'sbl');

function getToken(): string {
  let t = process.env.FINMIND_API_TOKEN?.replace(/['"]/g, '').trim() ?? '';
  if (t) return t;
  // Script context (npx tsx) 不會自動載 .env.local — 手動讀一次
  try {
    const envPath = path.join(process.cwd(), '.env.local');
    const txt = require('fs').readFileSync(envPath, 'utf8') as string;
    for (const line of txt.split('\n')) {
      const m = line.match(/^FINMIND_API_TOKEN\s*=\s*(.+)$/);
      if (m) { t = m[1].replace(/['"]/g, '').trim(); break; }
    }
    if (t) process.env.FINMIND_API_TOKEN = t;
  } catch { /* ignore */ }
  return t;
}

async function fmRange<T>(dataset: string, code: string, startDate: string, endDate: string): Promise<T[]> {
  const token = getToken();
  if (!token) return [];
  const url = `${FINMIND_API}?dataset=${dataset}&data_id=${encodeURIComponent(code)}&start_date=${startDate}&end_date=${endDate}&token=${encodeURIComponent(token)}`;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(20000), headers: { Accept: 'application/json' } });
    if (!res.ok) return [];
    const json = (await res.json()) as { status?: number; data?: T[] };
    if (json.status !== 200) return [];
    return json.data ?? [];
  } catch {
    return [];
  }
}

const toLots = (shares: number): number => {
  if (!shares) return 0;
  if (Math.abs(shares) < 1000) return shares >= 0 ? 1 : -1;
  return Math.round(shares / 1000);
};

// ── Cache file IO ─────────────────────────────────────────────

interface CacheFile<T extends { date: string }> {
  symbol: string;
  market: 'TW';
  lastDate: string;
  updatedAt: string;
  data: T[];
}

async function readCache<T extends { date: string }>(dir: string, code: string): Promise<CacheFile<T> | null> {
  try {
    const raw = await fs.readFile(path.join(dir, `${code}.json`), 'utf8');
    return JSON.parse(raw) as CacheFile<T>;
  } catch {
    return null;
  }
}

async function writeCache<T extends { date: string }>(dir: string, code: string, newRows: T[]): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
  const existing = await readCache<T>(dir, code);
  const map = new Map<string, T>();
  for (const r of existing?.data ?? []) map.set(r.date, r);
  for (const r of newRows) map.set(r.date, r);
  const merged = Array.from(map.values()).sort((a, b) => a.date.localeCompare(b.date));
  const file: CacheFile<T> = {
    symbol: code,
    market: 'TW',
    lastDate: merged[merged.length - 1]?.date ?? '',
    updatedAt: new Date().toISOString(),
    data: merged,
  };
  const { atomicFsPut } = await import('@/lib/storage/atomicFsPut');
  await atomicFsPut(path.join(dir, `${code}.json`), JSON.stringify(file));
}

// ── Margin (融資融券) ──────────────────────────────────────────

interface FmMarginRow {
  date: string;
  MarginPurchaseTodayBalance: number;
  MarginPurchaseYesterdayBalance: number;
  MarginPurchaseLimit: number;
  ShortSaleTodayBalance: number;
  ShortSaleYesterdayBalance: number;
}

export async function loadMarginRange(code: string, startDate: string, endDate: string): Promise<MarginDay[]> {
  const rows = await fmRange<FmMarginRow>('TaiwanStockMarginPurchaseShortSale', code, startDate, endDate);
  const mapped: MarginDay[] = rows.map(r => ({
    date: r.date,
    marginBalance: r.MarginPurchaseTodayBalance,
    marginNet: r.MarginPurchaseTodayBalance - r.MarginPurchaseYesterdayBalance,
    shortBalance: r.ShortSaleTodayBalance,
    shortNet: r.ShortSaleTodayBalance - r.ShortSaleYesterdayBalance,
    marginUtilRate: r.MarginPurchaseLimit > 0
      ? +((r.MarginPurchaseTodayBalance / r.MarginPurchaseLimit) * 100).toFixed(2)
      : 0,
  }));
  if (mapped.length > 0) await writeCache(MARGIN_DIR, code, mapped);
  return mapped;
}

export async function getMarginSeries(code: string, startDate: string, endDate: string): Promise<MarginDay[]> {
  const cached = await readCache<MarginDay>(MARGIN_DIR, code);
  const haveCache = cached?.data ?? [];
  const cacheLast = cached?.lastDate ?? '';
  // 若 cache 已包含 endDate（或更新），直接過濾回傳
  if (cacheLast && cacheLast >= endDate) {
    return haveCache.filter(r => r.date >= startDate && r.date <= endDate);
  }
  // 增量補：從 max(startDate, cacheLast+1) 抓到 endDate
  const fetchStart = cacheLast && cacheLast >= startDate ? nextDay(cacheLast) : startDate;
  const fresh = await loadMarginRange(code, fetchStart, endDate);
  // merge in-memory
  const map = new Map<string, MarginDay>();
  for (const r of haveCache) map.set(r.date, r);
  for (const r of fresh) map.set(r.date, r);
  return Array.from(map.values())
    .filter(r => r.date >= startDate && r.date <= endDate)
    .sort((a, b) => a.date.localeCompare(b.date));
}

// ── SBL (借券賣出) ─────────────────────────────────────────────

interface FmShortSaleRow {
  date: string;
  stock_id: string;
  SBLShortSalesShortSales: number;
  SBLShortSalesReturns: number;
  SBLShortSalesCurrentDayBalance: number;
}

export async function loadSblRange(code: string, startDate: string, endDate: string): Promise<SblDay[]> {
  const rows = await fmRange<FmShortSaleRow>('TaiwanDailyShortSaleBalances', code, startDate, endDate);
  const mapped: SblDay[] = rows.map(r => ({
    date: r.date,
    lendingBalance: toLots(r.SBLShortSalesCurrentDayBalance ?? 0),
    lendingNet: toLots((r.SBLShortSalesShortSales ?? 0) - (r.SBLShortSalesReturns ?? 0)),
  }));
  if (mapped.length > 0) await writeCache(SBL_DIR, code, mapped);
  return mapped;
}

export async function getSblSeries(code: string, startDate: string, endDate: string): Promise<SblDay[]> {
  const cached = await readCache<SblDay>(SBL_DIR, code);
  const haveCache = cached?.data ?? [];
  const cacheLast = cached?.lastDate ?? '';
  if (cacheLast && cacheLast >= endDate) {
    return haveCache.filter(r => r.date >= startDate && r.date <= endDate);
  }
  const fetchStart = cacheLast && cacheLast >= startDate ? nextDay(cacheLast) : startDate;
  const fresh = await loadSblRange(code, fetchStart, endDate);
  const map = new Map<string, SblDay>();
  for (const r of haveCache) map.set(r.date, r);
  for (const r of fresh) map.set(r.date, r);
  return Array.from(map.values())
    .filter(r => r.date >= startDate && r.date <= endDate)
    .sort((a, b) => a.date.localeCompare(b.date));
}

// ── Price + VWAP ──────────────────────────────────────────────

interface FmPriceRow {
  date: string;
  Trading_Volume: number;   // 股
  Trading_money: number;    // 元
  open: number;
  max: number;
  min: number;
  close: number;
}

interface LocalCandleFile {
  lastDate: string;
  candles: Array<{ date: string; open: number; high: number; low: number; close: number; volume: number }>;
}

/**
 * 讀本地 L1 K 棒 + 從 FinMind 補 Trading_money 算 VWAP；
 * FinMind 失敗則 fallback 用 (H+L+C)/3。
 */
export async function getPriceSeries(code: string, startDate: string, endDate: string): Promise<PriceDay[]> {
  // 1. 讀 local candles
  const localPath = path.join(process.cwd(), 'data', 'candles', 'TW', `${code}.TW.json`);
  let local: LocalCandleFile | null = null;
  try {
    local = JSON.parse(await fs.readFile(localPath, 'utf8')) as LocalCandleFile;
  } catch {
    local = null;
  }
  const inRange = (local?.candles ?? []).filter(c => c.date >= startDate && c.date <= endDate);

  // 2. 嘗試 FinMind 補 Trading_money
  const fm = await fmRange<FmPriceRow>('TaiwanStockPrice', code, startDate, endDate);
  const turnoverMap = new Map<string, number>();
  for (const r of fm) turnoverMap.set(r.date, r.Trading_money ?? 0);

  return inRange.map(c => {
    const tn = turnoverMap.get(c.date) ?? 0;
    // FinMind Trading_Volume 為「股」、本地 c.volume 亦為「股」；Trading_money 為「元」。
    // 經實測（6770 等），若 tn/volume 得到的「每股價」與 close 偏離 >5×，視為單位異常，fallback 用 (H+L+C)/3。
    let vwap = (c.high + c.low + c.close) / 3;
    if (tn > 0 && c.volume > 0) {
      const raw = tn / c.volume;
      if (Math.abs(raw - c.close) / Math.max(c.close, 1) <= 5) {
        vwap = raw;
      } else if (Math.abs(raw / 1000 - c.close) / Math.max(c.close, 1) <= 5) {
        vwap = raw / 1000;  // Trading_Volume 實際是張的情況
      }
    }
    return {
      date: c.date,
      open: c.open,
      high: c.high,
      low: c.low,
      close: c.close,
      volume: c.volume,
      turnover: tn,
      vwap: +vwap.toFixed(4),
    };
  });
}

// ── helpers ───────────────────────────────────────────────────

function nextDay(ymd: string): string {
  const d = new Date(ymd + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}
