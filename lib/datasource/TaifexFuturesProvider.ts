import type { Candle } from '@/types';

const TAIFEX_DAILY_URL = 'https://www.taifex.com.tw/cht/3/futDataDown';
const CACHE_TTL_MS = 5 * 60 * 1000;
const MAX_MONTHS = 24;
const FETCH_CONCURRENCY = 6;

type FuturesRow = Candle & {
  expiry: string;
  session: 'day' | 'after-hours';
};

const cache = new Map<string, { expiresAt: number; candles: Candle[] }>();

function toNumber(value: string): number | null {
  const normalized = value.trim().replaceAll(',', '');
  if (!normalized || normalized === '-') return null;
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

function combineContractRows(rows: FuturesRow[]): Candle | null {
  const day = rows.find((row) => row.session === 'day');
  const afterHours = rows.find((row) => row.session === 'after-hours');
  const valid = rows.filter((row) => row.open > 0 && row.high > 0 && row.low > 0 && row.close > 0);
  if (valid.length === 0) return null;

  // 期交所的「盤後」歸到次一交易日；完整交易日由前一晚開盤，日盤收盤結束。
  const open = afterHours?.open || day?.open || valid[0].open;
  const close = day?.close || afterHours?.close || valid.at(-1)!.close;
  return {
    date: valid[0].date,
    open,
    high: Math.max(...valid.map((row) => row.high)),
    low: Math.min(...valid.map((row) => row.low)),
    close,
    volume: valid.reduce((sum, row) => sum + row.volume, 0),
  };
}

/** 將期交所 TX CSV 轉成每日近月連續契約 K 線。 */
export function parseTaifexFuturesCsv(csv: string): Candle[] {
  const byDate = new Map<string, FuturesRow[]>();

  for (const line of csv.replace(/^\uFEFF/, '').split(/\r?\n/).slice(1)) {
    if (!line.trim()) continue;
    const cols = line.split(',');
    if (cols.length < 18 || cols[1]?.trim() !== 'TX') continue;

    const expiry = cols[2]?.trim();
    // 週契約不納入；連續線固定使用最近的月契約。
    if (!/^\d{6}$/.test(expiry)) continue;

    const open = toNumber(cols[3]);
    const high = toNumber(cols[4]);
    const low = toNumber(cols[5]);
    const close = toNumber(cols[6]);
    if (open == null || high == null || low == null || close == null) continue;

    const date = cols[0].trim().replaceAll('/', '-');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
    const sessionLabel = cols[17]?.trim();
    const row: FuturesRow = {
      date,
      expiry,
      open,
      high,
      low,
      close,
      volume: toNumber(cols[9]) ?? 0,
      session: sessionLabel.includes('盤後') ? 'after-hours' : 'day',
    };
    const list = byDate.get(date) ?? [];
    list.push(row);
    byDate.set(date, list);
  }

  const candles: Candle[] = [];
  for (const [date, rows] of [...byDate.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const month = date.slice(0, 7).replace('-', '');
    const expiries = [...new Set(rows.map((row) => row.expiry))].sort();
    const frontMonth = expiries.find((expiry) => expiry >= month) ?? expiries[0];
    const candle = combineContractRows(rows.filter((row) => row.expiry === frontMonth));
    if (candle) candles.push(candle);
  }
  return candles;
}

function addMonths(date: Date, amount: number): Date {
  const next = new Date(date);
  next.setUTCDate(1);
  next.setUTCMonth(next.getUTCMonth() + amount);
  return next;
}

function ymd(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function slashDate(date: Date): string {
  return ymd(date).replaceAll('-', '/');
}

function monthWindows(start: Date, end: Date): Array<{ start: Date; end: Date }> {
  const windows: Array<{ start: Date; end: Date }> = [];
  let cursor = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), 1));
  while (cursor <= end) {
    const nextMonth = addMonths(cursor, 1);
    const monthEnd = new Date(nextMonth.getTime() - 86_400_000);
    windows.push({
      start: cursor < start ? start : cursor,
      end: monthEnd > end ? end : monthEnd,
    });
    cursor = nextMonth;
  }
  return windows;
}

async function fetchMonth(start: Date, end: Date): Promise<Candle[]> {
  const body = new URLSearchParams({
    down_type: '1',
    queryStartDate: slashDate(start),
    queryEndDate: slashDate(end),
    commodity_id: 'TX',
    commodity_id2: '',
  });
  const response = await fetch(TAIFEX_DAILY_URL, {
    method: 'POST',
    body,
    cache: 'no-store',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': 'Mozilla/5.0 Rockstock/1.0',
    },
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`TAIFEX ${response.status}`);
  const csv = new TextDecoder('big5').decode(await response.arrayBuffer());
  return parseTaifexFuturesCsv(csv);
}

/** 取得臺股期貨 TX 最近月連續日 K；官方下載一次最多一個月，因此分月並行抓取。 */
export async function fetchTaifexTxFuturesCandles(asOfDate?: string): Promise<Candle[]> {
  const end = asOfDate
    ? new Date(`${asOfDate}T00:00:00Z`)
    : new Date(`${new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Taipei' }).format(new Date())}T00:00:00Z`);
  const start = addMonths(end, -MAX_MONTHS);
  const key = `${ymd(start)}:${ymd(end)}`;
  const cached = cache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.candles;

  const windows = monthWindows(start, end);
  const chunks: Candle[][] = [];
  for (let i = 0; i < windows.length; i += FETCH_CONCURRENCY) {
    const batch = windows.slice(i, i + FETCH_CONCURRENCY);
    const settled = await Promise.allSettled(batch.map((window) => fetchMonth(window.start, window.end)));
    for (const result of settled) {
      if (result.status === 'fulfilled') chunks.push(result.value);
    }
  }

  const candles = [...new Map(chunks.flat().map((candle) => [candle.date, candle])).values()]
    .sort((a, b) => a.date.localeCompare(b.date));
  if (candles.length === 0) throw new Error('期交所暫無臺股期貨資料');
  cache.set(key, { expiresAt: Date.now() + CACHE_TTL_MS, candles });
  return candles;
}
