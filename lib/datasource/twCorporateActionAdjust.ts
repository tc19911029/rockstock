import type { Candle } from '@/types';

export interface VerifiedTwCorporateAction {
  date: string;
  symbol: string;
  previousClose: number;
  referencePrice: number;
  /** Number of post-event shares corresponding to one pre-event share. */
  shareRatio: number;
  /** Multiplier applied to pre-event OHLC values. */
  priceFactor: number;
  source: 'TWSE' | 'TPEx';
  kind: 'stock-distribution' | 'par-value-change' | 'capital-reduction';
}

interface TwseResultPayload { stat?: string; data?: string[][] }
interface TwseDetailPayload { stat?: string; data?: string[][] }
interface TpexResultPayload { tables?: Array<{ data?: string[][] }> }

const resultCache = new Map<string, Promise<VerifiedTwCorporateAction | null>>();

// Audited against the official TWSE/TPEx result and detail tables. This keeps
// known adjustments deterministic when an exchange endpoint is temporarily
// unavailable; future events still use the live official lookup below.
const VERIFIED_ACTION_FALLBACKS: VerifiedTwCorporateAction[] = [
  { date: '2026-02-03', symbol: '4174.TWO', previousClose: 27.6, referencePrice: 55.2, shareRatio: 0.5, priceFactor: 2, source: 'TPEx', kind: 'capital-reduction' },
  { date: '2026-03-09', symbol: '8932.TWO', previousClose: 199.5, referencePrice: 99.75, shareRatio: 2, priceFactor: 0.5, source: 'TPEx', kind: 'par-value-change' },
  { date: '2026-04-13', symbol: '8937.TWO', previousClose: 145.5, referencePrice: 36.38, shareRatio: 4, priceFactor: 36.38 / 145.5, source: 'TPEx', kind: 'par-value-change' },
  { date: '2026-04-20', symbol: '3086.TWO', previousClose: 325, referencePrice: 32.5, shareRatio: 10, priceFactor: 0.1, source: 'TPEx', kind: 'par-value-change' },
  { date: '2026-06-29', symbol: '2380.TW', previousClose: 6.6, referencePrice: 23.86, shareRatio: 0.27658171, priceFactor: 23.86 / 6.6, source: 'TWSE', kind: 'capital-reduction' },
  { date: '2026-06-30', symbol: '3152.TWO', previousClose: 208, referencePrice: 360.24, shareRatio: 0.56531945, priceFactor: 360.24 / 208, source: 'TPEx', kind: 'capital-reduction' },
  { date: '2026-07-20', symbol: '5386.TWO', previousClose: 378, referencePrice: 251, shareRatio: 1.50000001386, priceFactor: 251 / 378, source: 'TPEx', kind: 'stock-distribution' },
  { date: '2026-08-10', symbol: '5904.TWO', previousClose: 720, referencePrice: 72, shareRatio: 10, priceFactor: 0.1, source: 'TPEx', kind: 'par-value-change' },
  { date: '2026-08-14', symbol: '5314.TWO', previousClose: 61.3, referencePrice: 14.75, shareRatio: 4.15702936097, priceFactor: 14.75 / 61.3, source: 'TPEx', kind: 'stock-distribution' },
  { date: '2026-08-31', symbol: '4747.TWO', previousClose: 56.5, referencePrice: 28.25, shareRatio: 2, priceFactor: 0.5, source: 'TPEx', kind: 'par-value-change' },
  { date: '2026-09-02', symbol: '6669.TW', previousClose: 7800, referencePrice: 2614.99, shareRatio: 2.9828, priceFactor: 2614.99 / 7800, source: 'TWSE', kind: 'stock-distribution' },
  { date: '2026-09-07', symbol: '6949.TW', previousClose: 1490, referencePrice: 74.5, shareRatio: 20, priceFactor: 0.05, source: 'TWSE', kind: 'par-value-change' },
  { date: '2026-09-09', symbol: '6461.TWO', previousClose: 16.65, referencePrice: 26.92, shareRatio: 0.618578, priceFactor: 26.92 / 16.65, source: 'TPEx', kind: 'capital-reduction' },
];

function numberOf(value: unknown): number {
  const parsed = Number(String(value ?? '').replace(/[^0-9.+-]/g, ''));
  return Number.isFinite(parsed) ? parsed : 0;
}

function compactDate(date: string): string {
  return date.replaceAll('-', '');
}

async function getJson<T>(url: string): Promise<T> {
  const response = await fetch(url, {
    headers: { Accept: 'application/json', 'User-Agent': 'Mozilla/5.0' },
    signal: AbortSignal.timeout(8_000),
  });
  if (!response.ok) throw new Error(`corporate action HTTP ${response.status}`);
  return await response.json() as T;
}

export function parseTwseCorporateAction(
  symbol: string,
  date: string,
  result: TwseResultPayload,
  detail: TwseDetailPayload,
): VerifiedTwCorporateAction | null {
  const code = symbol.replace(/\.(TW|TWO)$/i, '');
  const row = result.data?.find(item => item[1]?.trim() === code);
  const detailRow = detail.data?.find(item => item[0]?.trim() === code);
  if (!row || !detailRow || !row[6]?.includes('權')) return null;
  const previousClose = numberOf(row[3]);
  const referencePrice = numberOf(row[4]);
  const stockPerThousand = numberOf(detailRow[4]);
  if (!(previousClose > 0) || !(referencePrice > 0) || !(stockPerThousand > 0)) return null;
  const shareRatio = 1 + stockPerThousand / 1000;
  return {
    date,
    symbol: `${code}.TW`,
    previousClose,
    referencePrice,
    shareRatio,
    priceFactor: referencePrice / previousClose,
    source: 'TWSE',
    kind: 'stock-distribution',
  };
}

export function parseTpexCorporateAction(
  symbol: string,
  date: string,
  payload: TpexResultPayload,
): VerifiedTwCorporateAction | null {
  const code = symbol.replace(/\.(TW|TWO)$/i, '');
  const row = payload.tables?.[0]?.data?.find(item => item[1]?.trim() === code);
  if (!row || !row[8]?.includes('權')) return null;
  const previousClose = numberOf(row[3]);
  const referencePrice = numberOf(row[4]);
  const stockPerThousand = numberOf(row[14]);
  if (!(previousClose > 0) || !(referencePrice > 0) || !(stockPerThousand > 0)) return null;
  const shareRatio = 1 + stockPerThousand / 1000;
  return {
    date,
    symbol: `${code}.TWO`,
    previousClose,
    referencePrice,
    shareRatio,
    priceFactor: referencePrice / previousClose,
    source: 'TPEx',
    kind: 'stock-distribution',
  };
}

function ratioFromHtml(html: string, label: string): number {
  const normalized = html.replaceAll('&nbsp;', ' ').replaceAll('&nbsp', ' ');
  const match = normalized.match(new RegExp(`${label}[^<]*<\\/th>\\s*<td>([0-9,.]+)`, 'i'));
  return numberOf(match?.[1]);
}

export function parseTwseMechanicalAction(
  symbol: string,
  date: string,
  payload: TwseResultPayload,
  kind: 'par-value-change' | 'capital-reduction',
  detail?: TwseDetailPayload,
): VerifiedTwCorporateAction | null {
  const code = symbol.replace(/\.(TW|TWO)$/i, '');
  const row = payload.data?.find(item => item[1]?.trim() === code);
  if (!row) return null;
  const previousClose = numberOf(row[3]);
  const referencePrice = numberOf(row[4]);
  const detailRow = detail?.data?.find(item => item[0]?.trim() === code);
  const detailedRatio = kind === 'capital-reduction' ? numberOf(detailRow?.[3]) / 1000 : 0;
  // TWSE defines the reference price as previous close divided by the share ratio
  // for par-value changes and loss-compensation reductions. The detail value is
  // preferred when available because cash reductions have an additional cash leg.
  const shareRatio = detailedRatio > 0 ? detailedRatio : previousClose / referencePrice;
  if (!(previousClose > 0) || !(referencePrice > 0) || !(shareRatio > 0)) return null;
  return {
    date,
    symbol: `${code}.TW`,
    previousClose,
    referencePrice,
    shareRatio,
    priceFactor: referencePrice / previousClose,
    source: 'TWSE',
    kind,
  };
}

export function parseTpexMechanicalAction(
  symbol: string,
  date: string,
  payload: TpexResultPayload,
  kind: 'par-value-change' | 'capital-reduction',
): VerifiedTwCorporateAction | null {
  const code = symbol.replace(/\.(TW|TWO)$/i, '');
  const row = payload.tables?.[0]?.data?.find(item => item[1]?.trim() === code);
  if (!row) return null;
  const previousClose = numberOf(row[3]);
  const referencePrice = numberOf(row[4]);
  const detailHtml = row[kind === 'capital-reduction' ? 10 : 8] ?? '';
  const shareRatio = kind === 'capital-reduction'
    ? ratioFromHtml(detailHtml, '每壹仟股換發新股票') / 1000
    : ratioFromHtml(detailHtml, '變更股票面額換股率');
  if (!(previousClose > 0) || !(referencePrice > 0) || !(shareRatio > 0)) return null;
  return {
    date,
    symbol: `${code}.TWO`,
    previousClose,
    referencePrice,
    shareRatio,
    priceFactor: referencePrice / previousClose,
    source: 'TPEx',
    kind,
  };
}

async function fetchFirstVerified(fetchers: Array<() => Promise<VerifiedTwCorporateAction | null>>) {
  const results = await Promise.allSettled(fetchers.map(fetcher => fetcher()));
  for (const result of results) {
    if (result.status === 'fulfilled' && result.value) return result.value;
  }
  return null;
}

async function fetchVerifiedAction(symbol: string, date: string): Promise<VerifiedTwCorporateAction | null> {
  const key = `${symbol.toUpperCase()}:${date}`;
  const audited = VERIFIED_ACTION_FALLBACKS.find(action => `${action.symbol}:${action.date}` === key);
  if (audited) return audited;
  const cached = resultCache.get(key);
  if (cached) return cached;
  const promise = (async () => {
    const code = symbol.replace(/\.(TW|TWO)$/i, '');
    if (symbol.toUpperCase().endsWith('.TWO')) {
      const queryDate = encodeURIComponent(date.replaceAll('-', '/'));
      return fetchFirstVerified([
        async () => parseTpexCorporateAction(symbol, date, await getJson<TpexResultPayload>(
          `https://www.tpex.org.tw/www/zh-tw/bulletin/exDailyQ?startDate=${queryDate}&endDate=${queryDate}&response=json`,
        )),
        async () => parseTpexMechanicalAction(symbol, date, await getJson<TpexResultPayload>(
          `https://www.tpex.org.tw/www/zh-tw/bulletin/pvChgRslt?startDate=${queryDate}&endDate=${queryDate}&response=json`,
        ), 'par-value-change'),
        async () => parseTpexMechanicalAction(symbol, date, await getJson<TpexResultPayload>(
          `https://www.tpex.org.tw/www/zh-tw/bulletin/revivt?startDate=${queryDate}&endDate=${queryDate}&response=json`,
        ), 'capital-reduction'),
      ]);
    }
    const ymd = compactDate(date);
    return fetchFirstVerified([
      async () => {
        const [result, detail] = await Promise.all([
          getJson<TwseResultPayload>(
            `https://www.twse.com.tw/rwd/zh/exRight/TWT49U?response=json&startDate=${ymd}&endDate=${ymd}`,
          ),
          getJson<TwseDetailPayload>(
            `https://www.twse.com.tw/rwd/zh/exRight/TWT49UDetail?response=json&STK_NO=${code}&T1=${ymd}`,
          ),
        ]);
        return parseTwseCorporateAction(symbol, date, result, detail);
      },
      async () => parseTwseMechanicalAction(symbol, date, await getJson<TwseResultPayload>(
        `https://wwwc.twse.com.tw/rwd/zh/change/TWTB8U?response=json&startDate=${ymd}&endDate=${ymd}`,
      ), 'par-value-change'),
      async () => {
        const result = await getJson<TwseResultPayload>(
          `https://wwwc.twse.com.tw/rwd/zh/reducation/TWTAUU?response=json&startDate=${ymd}&endDate=${ymd}`,
        );
        const row = result.data?.find(item => item[1]?.trim() === code);
        const fileDate = row?.[10]?.split(',')[1]?.trim();
        const detail = fileDate ? await getJson<TwseDetailPayload>(
          `https://wwwc.twse.com.tw/rwd/zh/reducation/TWTAVUDetail?response=json&STK_NO=${code}&FILE_DATE=${fileDate}`,
        ) : undefined;
        return parseTwseMechanicalAction(symbol, date, result, 'capital-reduction', detail);
      },
    ]);
  })().catch(() => null);
  resultCache.set(key, promise);
  void promise.then(action => {
    // Keep verified announcements cached, but let transient official-source failures retry.
    if (!action && resultCache.get(key) === promise) resultCache.delete(key);
  });
  return promise;
}

export function applyVerifiedTwCorporateActions(
  candles: readonly Candle[],
  actions: readonly VerifiedTwCorporateAction[],
): Candle[] {
  if (actions.length === 0) return candles.map(candle => ({ ...candle }));
  const adjusted = candles.map(candle => ({ ...candle }));
  for (const action of [...actions].sort((a, b) => a.date.localeCompare(b.date))) {
    for (const candle of adjusted) {
      if (candle.date >= action.date) continue;
      candle.open = +(candle.open * action.priceFactor).toFixed(6);
      candle.high = +(candle.high * action.priceFactor).toFixed(6);
      candle.low = +(candle.low * action.priceFactor).toFixed(6);
      candle.close = +(candle.close * action.priceFactor).toFixed(6);
      candle.volume = Math.round(candle.volume * action.shareRatio);
    }
  }
  return adjusted;
}

export async function adjustTwCandlesForTechnicalUse(
  symbol: string,
  candles: readonly Candle[],
): Promise<{ candles: Candle[]; events: VerifiedTwCorporateAction[] }> {
  if (!/\.(TW|TWO)$/i.test(symbol) || candles.length < 2) {
    return { candles: candles.map(candle => ({ ...candle })), events: [] };
  }
  const candidates: Array<{ date: string; previousClose: number }> = [];
  for (let index = 1; index < candles.length; index += 1) {
    const previousClose = candles[index - 1].close;
    const close = candles[index].close;
    if (previousClose > 0 && close > 0 && Math.abs(close / previousClose - 1) > 0.25) {
      candidates.push({ date: candles[index].date, previousClose });
    }
  }
  if (candidates.length === 0) return { candles: candles.map(candle => ({ ...candle })), events: [] };
  const fetched = await Promise.all(candidates.map(candidate => fetchVerifiedAction(symbol, candidate.date)));
  const events = fetched.filter((event): event is VerifiedTwCorporateAction => !!event).filter(event => {
    const candidate = candidates.find(item => item.date === event.date);
    return !!candidate && Math.abs(candidate.previousClose / event.previousClose - 1) <= 0.002;
  });
  return { candles: applyVerifiedTwCorporateActions(candles, events), events };
}
