import type { Candle } from '@/types';
import { isTaifexPollingWindow } from '@/lib/datasource/marketHours';
import { isTradingDay } from '@/lib/utils/tradingDay';

const TAIFEX_DAILY_URL = 'https://www.taifex.com.tw/cht/3/futDataDown';
const TAIFEX_QUOTE_URL = 'https://mis.taifex.com.tw/futures/api/getQuoteList';
const CACHE_TTL_MS = 5 * 60 * 1000;
const MAX_MONTHS = 24;
const FETCH_CONCURRENCY = 6;

type FuturesRow = Candle & {
  expiry: string;
  session: 'day' | 'after-hours';
};

export interface TaifexQuoteRow {
  SymbolID: string;
  CDate: string;
  CTime: string;
  COpenPrice: string;
  CHighPrice: string;
  CLowPrice: string;
  CLastPrice: string;
  CTotalVolume: string;
}

export interface TaifexFuturesQuote extends Candle {
  session: 'day' | 'after-hours';
  quoteTime: string;
}

const cache = new Map<string, { expiresAt: number; candles: Candle[] }>();

function toNumber(value: string): number | null {
  const normalized = value.trim().replaceAll(',', '');
  if (!normalized || normalized === '-') return null;
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

function compactDateToIso(value: string): string | null {
  if (!/^\d{8}$/.test(value)) return null;
  return `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}`;
}

function nextTradingDate(date: string): string {
  const cursor = new Date(`${date}T12:00:00Z`);
  for (let i = 0; i < 14; i++) {
    cursor.setUTCDate(cursor.getUTCDate() + 1);
    const candidate = cursor.toISOString().slice(0, 10);
    if (isTradingDay(candidate, 'TW')) return candidate;
  }
  return date;
}

function selectActiveTxContract(rows: TaifexQuoteRow[], suffix: 'F' | 'M'): TaifexQuoteRow | null {
  return rows
    .filter((row) => new RegExp(`^TXF[A-L]\\d-${suffix}$`).test(row.SymbolID) && (toNumber(row.CLastPrice) ?? 0) > 0)
    .sort((a, b) => (toNumber(b.CTotalVolume) ?? 0) - (toNumber(a.CTotalVolume) ?? 0))[0] ?? null;
}

function rowToQuote(row: TaifexQuoteRow, date: string, session: TaifexFuturesQuote['session']): TaifexFuturesQuote | null {
  const open = toNumber(row.COpenPrice);
  const high = toNumber(row.CHighPrice);
  const low = toNumber(row.CLowPrice);
  const close = toNumber(row.CLastPrice);
  if (open == null || high == null || low == null || close == null || Math.min(open, high, low, close) <= 0) return null;
  return {
    date,
    open,
    high,
    low,
    close,
    volume: toNumber(row.CTotalVolume) ?? 0,
    session,
    quoteTime: row.CTime,
  };
}

function taipeiClock(now: Date): { date: string; minutes: number } {
  const date = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Taipei' }).format(now);
  const [hour, minute] = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Taipei', hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(now).split(':').map(Number);
  return { date, minutes: hour * 60 + minute };
}

/** 將期交所即時網站的日盤／夜盤 snapshot 合成目前的 TX 近月日 K。 */
export function buildTaifexTxFuturesQuote(
  dayRows: TaifexQuoteRow[],
  afterHoursRows: TaifexQuoteRow[],
  now = new Date(),
): TaifexFuturesQuote | null {
  if (!isTaifexPollingWindow(now)) return null;
  const clock = taipeiClock(now);
  const isDaySession = clock.minutes >= 525 && clock.minutes <= 825;

  if (!isDaySession) {
    const night = selectActiveTxContract(afterHoursRows, 'M');
    const sessionDate = night ? compactDateToIso(night.CDate) : null;
    const previousDate = new Date(`${clock.date}T12:00:00Z`);
    previousDate.setUTCDate(previousDate.getUTCDate() - 1);
    const expectedSessionDate = clock.minutes >= 900 ? clock.date : previousDate.toISOString().slice(0, 10);
    if (!night || !sessionDate || sessionDate !== expectedSessionDate) return null;
    return rowToQuote(night, nextTradingDate(sessionDate), 'after-hours');
  }

  const day = selectActiveTxContract(dayRows, 'F');
  const tradingDate = day ? compactDateToIso(day.CDate) : null;
  if (!day || !tradingDate || tradingDate !== clock.date) return null;
  const dayQuote = rowToQuote(day, tradingDate, 'day');
  if (!dayQuote) return null;

  // 日盤 K 的開盤要沿用前一晚；高低與量也合併。不同到期契約（換月日）不可混用。
  const night = selectActiveTxContract(afterHoursRows, 'M');
  const nightDate = night ? compactDateToIso(night.CDate) : null;
  const sameContract = night?.SymbolID.replace(/-M$/, '') === day.SymbolID.replace(/-F$/, '');
  const belongsToTradingDate = nightDate ? nextTradingDate(nightDate) === tradingDate : false;
  const nightQuote = night && nightDate && sameContract && belongsToTradingDate
    ? rowToQuote(night, tradingDate, 'after-hours')
    : null;
  if (!nightQuote) return dayQuote;

  return {
    date: tradingDate,
    open: nightQuote.open,
    high: Math.max(nightQuote.high, dayQuote.high),
    low: Math.min(nightQuote.low, dayQuote.low),
    close: dayQuote.close,
    volume: nightQuote.volume + dayQuote.volume,
    session: 'day',
    quoteTime: dayQuote.quoteTime,
  };
}

async function fetchQuoteRows(marketType: '0' | '1'): Promise<TaifexQuoteRow[]> {
  const response = await fetch(TAIFEX_QUOTE_URL, {
    method: 'POST',
    cache: 'no-store',
    headers: {
      'Accept': 'application/json',
      'Content-Type': 'application/json',
      'Referer': 'https://mis.taifex.com.tw/futures/',
      'User-Agent': 'Mozilla/5.0 Rockstock/1.0',
    },
    body: JSON.stringify({
      MarketType: marketType,
      SymbolType: 'F',
      KindID: '1',
      CID: '',
      ExpireMonth: '',
      RowSize: '全部',
      PageNo: '',
      SortColumn: '',
      AscDesc: 'A',
    }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`TAIFEX quote ${response.status}`);
  const json = await response.json() as {
    RtCode?: string;
    RtMsg?: string;
    RtData?: { QuoteList?: TaifexQuoteRow[] };
  };
  if (json.RtCode !== '0' || !Array.isArray(json.RtData?.QuoteList)) {
    throw new Error(json.RtMsg || '期交所即時報價暫無資料');
  }
  return json.RtData.QuoteList;
}

/** 取得目前 TX 近月盤中 snapshot；日盤會連同前一夜合成完整交易日 OHLCV。 */
export async function fetchTaifexTxFuturesQuote(now = new Date()): Promise<TaifexFuturesQuote | null> {
  if (!isTaifexPollingWindow(now)) return null;
  const { minutes } = taipeiClock(now);
  if (minutes >= 525 && minutes <= 825) {
    const [dayRows, afterHoursRows] = await Promise.all([fetchQuoteRows('0'), fetchQuoteRows('1')]);
    return buildTaifexTxFuturesQuote(dayRows, afterHoursRows, now);
  }
  const afterHoursRows = await fetchQuoteRows('1');
  return buildTaifexTxFuturesQuote([], afterHoursRows, now);
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
