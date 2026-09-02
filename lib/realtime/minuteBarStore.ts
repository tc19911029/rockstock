/**
 * minuteBarStore — 即時分鐘 K 線 in-memory ring buffer
 *
 * 設計：
 *   - 每個 symbol 一個 MinuteBar[] 升序陣列（cap REALTIME_RULES.RING_BUFFER_CAPACITY）
 *   - pushTick(symbol, market, snapshot) 收到 quote tick → 落入當前分鐘 bar，
 *     跨分鐘自動 close 上一根、開新根
 *   - volume 處理：quote.volume 是「當日累積」，bar.volume 用 delta = current - lastSeen
 *   - 啟動時 backfillFromVendor() 從 Yahoo (TW) / Sina (CN) 補滿當日歷史 1m bar
 *   - 每 60s flush dirty symbols 到 data/realtime/{date}/{symbol}.json
 *   - dev server 重啟後 restoreFromDisk() 載回 buffer
 *
 * 鐵律：
 *   1. 不可在 module top-level 跑 setInterval（會被 edge bundler 拉進去）—
 *      flush loop 由呼叫端（instrumentation.ts）顯式 startFlushLoop() 啟動
 *   2. 不寫盤 / 不發 ntfy — 純資料層；偵測與推播由 blowoffDetector / alertDispatcher 負責
 *
 * Symbol 正規化：
 *   外部 IO 統一用「帶 suffix」格式對齊 holdings.json：3661.TW / 6488.TWO / 603986.SS / 000858.SZ
 *   suffix 由呼叫端決定（pushTick 直接收帶 suffix 的 symbol）
 */

import { REALTIME_RULES } from '@/lib/config';

export interface MinuteBar {
  /** 帶 suffix：3661.TW / 6488.TWO / 603986.SS */
  symbol: string;
  market: 'TW' | 'CN';
  /** 該分鐘起始 timestamp (epoch ms, floor to minute) */
  ts: number;
  open: number;
  high: number;
  low: number;
  close: number;
  /** 該分鐘成交量（張），由 cumulative delta 推算 */
  volume: number;
  /** 累積到此 bar 的 tick 次數（debug 用） */
  tickCount: number;
}

export interface MinuteBarQuoteSnapshot {
  /** 最新成交價 */
  price: number;
  /** 該股當日累積成交量（張） */
  cumulativeVolume: number;
  /** 取得時間 (epoch ms)；缺省用 Date.now() */
  ts?: number;
}

interface BufferEntry {
  bars: MinuteBar[];
  /** symbol 當日上次 tick 看到的累積 volume（用於算 bar.volume delta） */
  lastSeenCumVol: number;
  /** 該 symbol 自上次 flush 後是否有變動 */
  dirty: boolean;
}

// ── module state ─────────────────────────────────────────────────────────

const buffers: Map<string, BufferEntry> = new Map();

/** 當前 buffer 對應的「市場日」key — 跨日要清空。TW & CN 共用同一個（CST 為主） */
let currentDateKey = todayTaipei();

let flushTimer: ReturnType<typeof setInterval> | null = null;

// ── public API ───────────────────────────────────────────────────────────

/**
 * 確保某個 symbol 進入 buffer pool（若無就 init 空陣列）
 * 由 monitorPool 在進入掃描前呼叫，保證 detector 有 entry 可讀
 */
export function ensureSymbol(symbol: string, market: 'TW' | 'CN'): void {
  if (!buffers.has(symbol)) {
    buffers.set(symbol, {
      bars: [],
      lastSeenCumVol: 0,
      dirty: false,
    });
  }
  void market;
}

/**
 * 收到報價 tick → 落入當前分鐘 bar。跨分鐘 close 舊根開新根。
 *
 * 注意：snapshot.cumulativeVolume 是「該股當日累積量」，
 * bar.volume 用 (current - lastSeen) delta 算這分鐘的增量。
 * 第一次 tick 時 lastSeen=0，delta=cumulativeVolume → 開盤第一根 bar 會吃整段
 * 集合競價 + 前面所有累積（這是已知行為，blowoffDetector 內部會排除第一根 bar）。
 *
 * 交易時段 guard：盤外（含 CN 午休）的 tick 直接 drop，避免 stale quote 開出
 * V=0 OHLC 全=收盤價的假 bar 污染 buffer（5m aggregate 後會誤觸 ma5-breakdown）。
 */
export function pushTick(
  symbol: string,
  market: 'TW' | 'CN',
  snap: MinuteBarQuoteSnapshot,
): void {
  const tickMs = snap.ts ?? Date.now();
  if (!isInTradingSession(market, tickMs)) return;
  maybeRollover();
  ensureSymbol(symbol, market);
  const entry = buffers.get(symbol)!;
  const ts = floorMinute(tickMs);
  // 冷啟動若尚無任何歷史 bar，只把第一個累積量當 baseline，不把「今天截至目前」
  // 全灌進當前分鐘。後續 backfill 會補齊先前分鐘；即使 vendor 暫時失敗，也寧可
  // 少算第一個取樣區間，不能製造一根假的巨量 K。
  const establishingBaseline = entry.bars.length === 0 && entry.lastSeenCumVol === 0;
  const delta = establishingBaseline
    ? 0
    : Math.max(0, snap.cumulativeVolume - entry.lastSeenCumVol);
  entry.lastSeenCumVol = snap.cumulativeVolume;

  const last = entry.bars[entry.bars.length - 1];
  if (last && last.ts === ts) {
    // 同分鐘 → update
    if (snap.price > last.high) last.high = snap.price;
    if (snap.price < last.low) last.low = snap.price;
    last.close = snap.price;
    last.volume += delta;
    last.tickCount += 1;
  } else {
    // 新分鐘 → push new bar
    entry.bars.push({
      symbol,
      market,
      ts,
      open: snap.price,
      high: snap.price,
      low: snap.price,
      close: snap.price,
      volume: delta,
      tickCount: 1,
    });
    // ring cap
    if (entry.bars.length > REALTIME_RULES.RING_BUFFER_CAPACITY) {
      entry.bars.splice(0, entry.bars.length - REALTIME_RULES.RING_BUFFER_CAPACITY);
    }
  }
  entry.dirty = true;
}

/**
 * 直接插入（用於 vendor backfill / restoreFromDisk）。
 * 跳過 lastSeenCumVol 邏輯，bar.volume 視為「已知正確」。
 */
export function ingestHistoricalBars(
  symbol: string,
  market: 'TW' | 'CN',
  bars: MinuteBar[],
): void {
  if (bars.length === 0) return;
  maybeRollover();
  ensureSymbol(symbol, market);
  const entry = buffers.get(symbol)!;
  // merge by ts (歷史 bar 不應覆蓋已 tick 的當前 bar)
  const existing = new Map(entry.bars.map(b => [b.ts, b]));
  for (const b of bars) {
    if (!existing.has(b.ts)) existing.set(b.ts, b);
  }
  entry.bars = Array.from(existing.values()).sort((a, b) => a.ts - b.ts);
  if (entry.bars.length > REALTIME_RULES.RING_BUFFER_CAPACITY) {
    entry.bars.splice(0, entry.bars.length - REALTIME_RULES.RING_BUFFER_CAPACITY);
  }
  // Live quote 的 volume 是「當日累積量」，歷史 bar 的 volume 則是「單分鐘量」。
  // 不能把最後一根分鐘量直接塞進 lastSeenCumVol；否則下一個 live tick 會把
  // 幾乎整天的累積量灌進單根 K，製造假的爆量訊號。若 live tick 已先抵達，
  // 也不可讓較慢完成的 backfill 把它的基準倒退。
  const historicalCumVol = bars.reduce((sum, bar) => sum + Math.max(0, bar.volume), 0);
  entry.lastSeenCumVol = Math.max(entry.lastSeenCumVol, historicalCumVol);
  entry.dirty = true;
}

/** 取 1m bars（升序），symbol 不存在回 [] */
export function getBars(symbol: string): MinuteBar[] {
  const entry = buffers.get(symbol);
  return entry ? entry.bars.slice() : [];
}

/** 列出所有 buffer 內的 symbol */
export function listSymbols(): string[] {
  return Array.from(buffers.keys());
}

/** 聚合 1m → 5m / 15m bars */
export function aggregateBars(bars: MinuteBar[], tfMin: 1 | 5 | 15): MinuteBar[] {
  if (tfMin === 1) return bars;
  if (bars.length === 0) return [];
  const stepMs = tfMin * 60_000;
  const groups: Map<number, MinuteBar[]> = new Map();
  for (const b of bars) {
    const key = Math.floor(b.ts / stepMs) * stepMs;
    let arr = groups.get(key);
    if (!arr) { arr = []; groups.set(key, arr); }
    arr.push(b);
  }
  const out: MinuteBar[] = [];
  for (const [key, group] of groups) {
    out.push({
      symbol: group[0].symbol,
      market: group[0].market,
      ts: key,
      open: group[0].open,
      high: Math.max(...group.map(g => g.high)),
      low: Math.min(...group.map(g => g.low)),
      close: group[group.length - 1].close,
      volume: group.reduce((s, g) => s + g.volume, 0),
      tickCount: group.reduce((s, g) => s + g.tickCount, 0),
    });
  }
  return out.sort((a, b) => a.ts - b.ts);
}

// ── Vendor backfill ──────────────────────────────────────────────────────

/**
 * 從 vendor 拉今日 1m bars 補當下 buffer 缺口
 *   TW: Yahoo Finance v8 chart API (interval=1m, range=1d)
 *   CN: 既有 getSinaMinuteCandles (1m, ~5 天歷史)
 *
 * 失敗（rate limit / 海外阻擋）會 log 但不擲錯 — 後續 live tick 仍會累積。
 */
export async function backfillFromVendor(
  symbol: string,
  market: 'TW' | 'CN',
): Promise<{ ok: boolean; count: number; error?: string }> {
  try {
    const bars = market === 'TW'
      ? await fetchYahooMinuteBars(symbol)
      : await fetchSinaMinuteBars(symbol);
    if (bars.length === 0) return { ok: false, count: 0, error: 'empty' };
    ingestHistoricalBars(symbol, market, bars);
    return { ok: true, count: bars.length };
  } catch (err) {
    return {
      ok: false,
      count: 0,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

async function fetchYahooMinuteBars(symbol: string): Promise<MinuteBar[]> {
  // Yahoo 對 .TW/.TWO 提供 1m bar，range=1d 拿當日（盤前回前一交易日）
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1m&range=1d&includePrePost=false`;
  const res = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0' },
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`yahoo http ${res.status}`);
  const json = await res.json() as {
    chart?: { result?: Array<{
      timestamp?: number[];
      indicators?: { quote?: Array<{
        open?: (number | null)[]; high?: (number | null)[];
        low?: (number | null)[]; close?: (number | null)[]; volume?: (number | null)[];
      }> };
    }> };
  };
  const r = json.chart?.result?.[0];
  const ts = r?.timestamp ?? [];
  const q = r?.indicators?.quote?.[0];
  if (!q || ts.length === 0) return [];
  const bars: MinuteBar[] = [];
  const todayKey = todayTaipei();
  for (let i = 0; i < ts.length; i++) {
    const o = q.open?.[i], h = q.high?.[i], l = q.low?.[i], c = q.close?.[i], v = q.volume?.[i];
    if (o == null || h == null || l == null || c == null) continue;
    const tsMs = ts[i] * 1000;
    if (dateKeyOfMs(tsMs, 'TW') !== todayKey) continue; // 只取今日
    bars.push({
      symbol, market: 'TW',
      ts: floorMinute(tsMs),
      open: o, high: h, low: l, close: c,
      // Yahoo .TW 1m volume 單位是「股」，rockstock 全套用「張」(1張=1000股)
      volume: Math.round((v ?? 0) / 1000),
      tickCount: 1,
    });
  }
  return bars;
}

async function fetchSinaMinuteBars(symbol: string): Promise<MinuteBar[]> {
  const { getSinaMinuteCandles } = await import('@/lib/datasource/EastMoneyHistProvider');
  const candles = await getSinaMinuteCandles(symbol, '1m');
  const todayKey = todayShanghai();
  const bars: MinuteBar[] = [];
  for (const c of candles) {
    // c.date 形式 "YYYY-MM-DD HH:mm"
    const tsMs = parseShanghaiDateTimeToMs(c.date);
    if (!tsMs) continue;
    if (dateKeyOfMs(tsMs, 'CN') !== todayKey) continue;
    bars.push({
      symbol, market: 'CN',
      ts: floorMinute(tsMs),
      open: c.open, high: c.high, low: c.low, close: c.close,
      volume: c.volume, // Sina 已 ÷100 轉張
      tickCount: 1,
    });
  }
  return bars;
}

// ── Disk persistence ─────────────────────────────────────────────────────

export async function flushDirtyToDisk(): Promise<{ written: number; skipped: number }> {
  let written = 0, skipped = 0;
  for (const [symbol, entry] of buffers) {
    if (!entry.dirty || entry.bars.length === 0) { skipped++; continue; }
    try {
      await writeBuffer(symbol, entry);
      entry.dirty = false;
      written++;
    } catch (err) {
      console.warn(`[minuteBarStore] flush ${symbol} 失敗:`, err);
    }
  }
  return { written, skipped };
}

async function writeBuffer(symbol: string, entry: BufferEntry): Promise<void> {
  const { promises: fs } = await import('fs');
  const path = await import('path');
  const { atomicFsPut } = await import('@/lib/storage/atomicFsPut');
  const dir = path.join(process.cwd(), 'data', 'realtime', currentDateKey);
  await fs.mkdir(dir, { recursive: true });
  const filename = path.join(dir, `${safeFilename(symbol)}.json`);
  const data = JSON.stringify({
    symbol,
    market: entry.bars[0]?.market ?? 'TW',
    date: currentDateKey,
    lastSeenCumVol: entry.lastSeenCumVol,
    bars: entry.bars,
  });
  await atomicFsPut(filename, data);
}

/**
 * 啟動時從 data/realtime/{today}/*.json 載回所有 bar 到 buffer
 * 由 instrumentation.ts register() 呼叫一次
 */
export async function restoreFromDisk(): Promise<{ loaded: number; symbols: string[] }> {
  const { promises: fs } = await import('fs');
  const path = await import('path');
  const dir = path.join(process.cwd(), 'data', 'realtime', currentDateKey);
  try {
    const files = await fs.readdir(dir);
    let loaded = 0;
    const symbols: string[] = [];
    for (const f of files) {
      if (!f.endsWith('.json')) continue;
      try {
        const raw = await fs.readFile(path.join(dir, f), 'utf-8');
        const parsed = JSON.parse(raw) as {
          symbol: string; market: 'TW' | 'CN';
          lastSeenCumVol?: number; bars: MinuteBar[];
        };
        buffers.set(parsed.symbol, {
          bars: parsed.bars,
          lastSeenCumVol: parsed.lastSeenCumVol ?? 0,
          dirty: false,
        });
        loaded += parsed.bars.length;
        symbols.push(parsed.symbol);
      } catch (err) {
        console.warn(`[minuteBarStore] restore ${f} 失敗:`, err);
      }
    }
    return { loaded, symbols };
  } catch {
    return { loaded: 0, symbols: [] };
  }
}

/**
 * 啟動 flush loop（每 REALTIME_RULES.FLUSH_INTERVAL_MS flush dirty 到 disk）
 * 鐵律：不在 module top-level 自動啟動，由 instrumentation.ts 顯式呼叫一次。
 * test 環境不啟動。
 */
export function startFlushLoop(): void {
  if (flushTimer) return;
  if (process.env.NODE_ENV === 'test') return;
  flushTimer = setInterval(() => {
    flushDirtyToDisk().catch(err => console.warn('[minuteBarStore] flush loop err:', err));
    maybeRollover();
  }, REALTIME_RULES.FLUSH_INTERVAL_MS);
}

export function stopFlushLoop(): void {
  if (flushTimer) {
    clearInterval(flushTimer);
    flushTimer = null;
  }
}

// ── helpers ──────────────────────────────────────────────────────────────

function floorMinute(ms: number): number {
  return Math.floor(ms / 60_000) * 60_000;
}

function todayTaipei(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Taipei' }).format(new Date());
}

function todayShanghai(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(new Date());
}

function dateKeyOfMs(ms: number, market: 'TW' | 'CN'): string {
  const tz = market === 'TW' ? 'Asia/Taipei' : 'Asia/Shanghai';
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(new Date(ms));
}

function parseShanghaiDateTimeToMs(s: string): number | null {
  // "YYYY-MM-DD HH:mm" Asia/Shanghai → epoch ms
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})$/);
  if (!m) return null;
  // Asia/Shanghai 全年 UTC+8 無 DST
  const utcMs = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4] - 8, +m[5]);
  return utcMs;
}

function safeFilename(symbol: string): string {
  return symbol.replace(/[^a-zA-Z0-9._-]/g, '_');
}

function maybeRollover(): void {
  const today = todayTaipei();
  if (today !== currentDateKey) {
    // 跨日：先 flush 舊日（best-effort fire-and-forget），再清空 buffer
    flushDirtyToDisk().catch(() => {});
    buffers.clear();
    currentDateKey = today;
  }
}

/**
 * 是否在連續競價時段內（含 CN 午休排除）
 *   TW: 09:00–13:30
 *   CN: 09:15–11:30 + 13:00–15:00
 * 用市場時區的 hour*100+min 比對；週末 / 假日 一律 false（不引入 isTradingDay
 * 依賴是因為這層只負責「不接 stale tick」，假日 cron 本來就會被外層 isMarketOpen 擋住）。
 */
export function isInTradingSession(market: 'TW' | 'CN', ms: number): boolean {
  const tz = market === 'TW' ? 'Asia/Taipei' : 'Asia/Shanghai';
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hour: 'numeric', minute: 'numeric', weekday: 'short', hour12: false,
  }).formatToParts(new Date(ms));
  const get = (t: string) => parts.find(p => p.type === t)?.value ?? '';
  const wd = get('weekday');
  if (wd === 'Sat' || wd === 'Sun') return false;
  const hhmm = parseInt(get('hour'), 10) * 100 + parseInt(get('minute'), 10);
  if (market === 'TW') {
    return hhmm >= 900 && hhmm <= 1330;
  }
  // CN：09:15–11:30 上午 + 13:00–15:00 下午
  return (hhmm >= 915 && hhmm <= 1130) || (hhmm >= 1300 && hhmm <= 1500);
}

// ── test-only ────────────────────────────────────────────────────────────

/** 測試用：清空 buffer */
export function _resetForTest(): void {
  buffers.clear();
  currentDateKey = todayTaipei();
}

/** 測試用：直接灌 bars（繞過 tick 邏輯） */
export function _injectBarsForTest(symbol: string, market: 'TW' | 'CN', bars: MinuteBar[]): void {
  buffers.set(symbol, {
    bars: bars.slice().sort((a, b) => a.ts - b.ts),
    lastSeenCumVol: bars.reduce((sum, bar) => sum + Math.max(0, bar.volume), 0),
    dirty: false,
  });
}
