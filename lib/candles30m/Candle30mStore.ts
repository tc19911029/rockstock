/**
 * Candle30mStore — 30 分K 資料層（六條件30分K盤中掃描專用）
 *
 * 為什麼要這一層：全市場快照(L2)只有「今日一根」日K + MABase(~20 根日收盤)，
 * 算不出 30 分K六條件要的 ~120 根暖機(MA60)。Fugle 也沒有「全市場30分K一次給」端點，
 * 逐檔即時抓 500 檔 = ~10 分鐘/輪 + 搶 Fugle 額度。
 *
 * 解法(使用者拍板)：自己蓋一個「30分K快照層」——
 *   ① 暖機/歷史(準確)：一次性 backfill + 每日盤後用 Fugle 準確30分K刷新
 *   ② 盤中堆疊(近似)：每 30 分讀一次全市場 L2 快照，為每檔 append 一根今日30分K
 *      (一次快照讀取、無逐檔抓；高低點用「今日累計高/低是否創新」近似)
 *
 * 儲存：**單一檔案**存整個宇宙(比照 L2 單檔哲學，一次讀完供掃描)
 *   Blob:  candles-30m/TW.json
 *   Local: data/candles-30m-TW.json
 * cursor(算 30 分 delta 用，每日一份)：
 *   Local: data/candles-30m-TW-cursor-{date}.json
 *
 * 此層獨立於 Layer 1（歷史日K），不可互相覆蓋（鐵則 #1）。
 */
import type { Candle } from '@/types/index';
import type { IntradayQuote } from '@/lib/datasource/IntradayCache';

const IS_VERCEL = !!process.env.VERCEL;
const RETENTION_DAYS = 15;         // 保留近 15 交易日(MA60 需 ≥60 根 ≈ 7 天，留餘裕)
const MARKET = 'TW' as const;

export interface Candle30mUniverse {
  market: 'TW';
  /** 最後更新交易日 YYYY-MM-DD */
  date: string;
  updatedAt: string;
  /** symbol(純代碼) → 升序 30 分K 陣列(date = "YYYY-MM-DD HH:mm") */
  data: Record<string, Candle[]>;
}

/** 盤中堆疊 cursor：上一個 30 分邊界時每檔的今日累計值(算 delta 用) */
export interface Candle30mCursor {
  date: string;
  updatedAt: string;
  /** symbol → 上一邊界的今日累計 { close, high, low, cumVolume } */
  data: Record<string, { close: number; high: number; low: number; cumVolume: number }>;
}

// ── Blob / FS helpers（比照 IntradayCache）──────────────────────────────────

function blobKey(): string { return `candles-30m/${MARKET}.json`; }
function localFilename(): string { return `candles-30m-${MARKET}.json`; }
function cursorLocalFilename(date: string): string { return `candles-30m-${MARKET}-cursor-${date}.json`; }
function cursorBlobKey(date: string): string { return `candles-30m/${MARKET}-cursor-${date}.json`; }

async function blobPut(pathname: string, data: string): Promise<void> {
  const { put } = await import('@vercel/blob');
  await put(pathname, data, { access: 'private', addRandomSuffix: false, allowOverwrite: true });
}

async function blobGet(pathname: string): Promise<string | null> {
  const { get } = await import('@vercel/blob');
  const result = await get(pathname, { access: 'private' });
  if (!result || !result.stream) return null;
  const reader = result.stream.getReader();
  const chunks: Uint8Array[] = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) chunks.push(value);
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}

async function fsPut(filename: string, data: string): Promise<void> {
  const { promises: fs } = await import('fs');
  const path = await import('path');
  const { atomicFsPut } = await import('@/lib/storage/atomicFsPut');
  const dir = path.join(process.cwd(), 'data');
  await fs.mkdir(dir, { recursive: true });
  await atomicFsPut(path.join(dir, filename), data);
}

async function fsGet(filename: string): Promise<string | null> {
  const { promises: fs } = await import('fs');
  const path = await import('path');
  try {
    return await fs.readFile(path.join(process.cwd(), 'data', filename), 'utf-8');
  } catch {
    return null;
  }
}

// ── 宇宙讀寫 ─────────────────────────────────────────────────────────────────

export async function read30mUniverse(): Promise<Candle30mUniverse | null> {
  let raw: string | null = null;
  if (IS_VERCEL) raw = await blobGet(blobKey());
  if (!raw) raw = await fsGet(localFilename());
  if (!raw) return null;
  try { return JSON.parse(raw) as Candle30mUniverse; } catch { return null; }
}

export async function write30mUniverse(u: Candle30mUniverse): Promise<void> {
  const json = JSON.stringify(u);
  if (IS_VERCEL) await blobPut(blobKey(), json);
  try { await fsPut(localFilename(), json); } catch { /* Vercel 只讀目錄，忽略 */ }
}

// ── cursor 讀寫 ──────────────────────────────────────────────────────────────

export async function read30mCursor(date: string): Promise<Candle30mCursor | null> {
  let raw: string | null = null;
  if (IS_VERCEL) raw = await blobGet(cursorBlobKey(date));
  if (!raw) raw = await fsGet(cursorLocalFilename(date));
  if (!raw) return null;
  try { return JSON.parse(raw) as Candle30mCursor; } catch { return null; }
}

export async function write30mCursor(c: Candle30mCursor): Promise<void> {
  const json = JSON.stringify(c);
  if (IS_VERCEL) await blobPut(cursorBlobKey(c.date), json);
  try { await fsPut(cursorLocalFilename(c.date), json); } catch { /* ignore */ }
}

// ── 工具 ─────────────────────────────────────────────────────────────────────

/** 取 "YYYY-MM-DD HH:mm" 或 "YYYY-MM-DD" 的日期部分 */
function dayOf(barDate: string): string { return barDate.slice(0, 10); }

const TW_CLOSE_LABEL = '13:30';
function addMinLabel(hhmm: string, add: number): string {
  const [h, m] = hhmm.split(':').map(Number);
  const t = h * 60 + m + add;
  return `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`;
}

/**
 * 把 Fugle 30分K(用「開始時間」標記，09:00=09:00-09:30，且 13:30 收盤競價是獨立退化根)
 * 正規化成「結束時間」9 根/日網格(09:30/10:00/.../13:30)，與盤中 L2 堆疊(用結束時間標)一致。
 * 收盤競價(start 13:30)併入 13:30 那根(13:00-13:30 窗)避免退化 O=H=L=C 誤判六條件。
 */
export function normalizeFugle30mToEndGrid(cs: Candle[]): Candle[] {
  const groups = new Map<string, Candle>();
  for (const c of cs) {
    if (!c.date.includes(' ')) continue; // 只處理分鐘K
    const day = c.date.slice(0, 10);
    const start = c.date.slice(11, 16);
    let end = addMinLabel(start, 30);
    if (end > TW_CLOSE_LABEL) end = TW_CLOSE_LABEL; // 收盤競價併入 13:30、超界夾住
    const key = `${day} ${end}`;
    const g = groups.get(key);
    if (!g) groups.set(key, { date: key, open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume });
    else { g.high = Math.max(g.high, c.high); g.low = Math.min(g.low, c.low); g.close = c.close; g.volume += c.volume; }
  }
  return [...groups.values()].sort((a, b) => a.date.localeCompare(b.date));
}

/** 去重(同 date 後蓋前)、升序、剪到近 RETENTION_DAYS 交易日 */
export function mergePrune(existing: Candle[], incoming: Candle[]): Candle[] {
  const map = new Map<string, Candle>();
  for (const c of existing) map.set(c.date, c);
  for (const c of incoming) map.set(c.date, c); // incoming 覆蓋(盤後準確版蓋盤中近似版)
  const sorted = [...map.values()].sort((a, b) => a.date.localeCompare(b.date));
  // 保留近 RETENTION_DAYS 個不同日曆日
  const days = [...new Set(sorted.map(c => dayOf(c.date)))];
  if (days.length <= RETENTION_DAYS) return sorted;
  const keepFrom = days[days.length - RETENTION_DAYS];
  return sorted.filter(c => dayOf(c.date) >= keepFrom);
}

/**
 * 用整批準確 30 分K 覆蓋宇宙(backfill / 盤後刷新用)。
 * @param bars symbol → 該檔完整 30 分K(升序)
 */
export async function upsert30mUniverse(date: string, bars: Record<string, Candle[]>): Promise<void> {
  const u = (await read30mUniverse()) ?? { market: MARKET, date, updatedAt: '', data: {} };
  for (const [sym, cs] of Object.entries(bars)) {
    if (!cs.length) continue;
    u.data[sym] = mergePrune(u.data[sym] ?? [], cs);
  }
  u.date = date;
  u.updatedAt = new Date().toISOString();
  await write30mUniverse(u);
}

/**
 * 盤中堆疊：讀 L2 快照，為每檔算出「本邊界的 30 分K」append 到宇宙，並更新 cursor。
 *
 * 30 分K 由「上一邊界 cursor」與「當下快照」推導：
 *   close  = 快照今日收盤(當下價)
 *   open   = 上一邊界收盤(無 cursor=今日開盤)
 *   volume = 今日累計量差(cumVol_now - cumVol_prev；無 cursor=今日累計量)
 *   high/low = 若今日累計高/低較上一邊界「創新」→ 用新累計高/低(表示本窗內做出)；
 *              否則退回 max/min(open,close)(近似，使用者已接受盤中糊)
 *
 * @param barTime  本邊界時間字串 "HH:mm"(如 "10:00")
 * @returns { appended } 有 append 幾檔
 */
export async function appendIntraday30mBar(
  date: string,
  barTime: string,
  quotes: IntradayQuote[],
): Promise<{ appended: number }> {
  const barDate = `${date} ${barTime}`;
  const prevCursor = await read30mCursor(date);
  const u = (await read30mUniverse()) ?? { market: MARKET, date, updatedAt: '', data: {} };
  const nextCursor: Candle30mCursor = { date, updatedAt: new Date().toISOString(), data: {} };
  let appended = 0;

  for (const q of quotes) {
    if (!(q.close > 0)) continue;
    // L2 symbol 是裸碼("2330")，宇宙 key 帶 .TW；且只堆疊「已在暖機宇宙(top500)」的股，
    // 避免把全市場 2000+ 檔灌進來無界膨脹(非暖機股只有近似 bar、無 Fugle 準確歷史)。
    const key = `${q.symbol}.TW`;
    if (!u.data[key]) continue;
    const prev = prevCursor?.data[key];
    const open = prev ? prev.close : (q.open > 0 ? q.open : q.close);
    const volume = prev ? Math.max(0, q.volume - prev.cumVolume) : q.volume;
    // 本窗高/低：今日累計高/低若比上一邊界更極端 → 本窗內做出，用它；否則退回 open/close 範圍
    const madeNewHigh = prev ? q.high > prev.high : true;
    const madeNewLow = prev ? q.low < prev.low : true;
    const high = Math.max(open, q.close, madeNewHigh ? q.high : Math.max(open, q.close));
    const low = Math.min(open, q.close, madeNewLow ? q.low : Math.min(open, q.close));

    const bar: Candle = { date: barDate, open, high, low, close: q.close, volume };
    u.data[key] = mergePrune(u.data[key], [bar]);
    appended++;
    nextCursor.data[key] = { close: q.close, high: q.high, low: q.low, cumVolume: q.volume };
  }

  u.date = date;
  u.updatedAt = new Date().toISOString();
  await write30mUniverse(u);
  await write30mCursor(nextCursor);
  return { appended };
}
