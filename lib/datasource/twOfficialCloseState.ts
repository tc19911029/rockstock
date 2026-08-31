import {
  TW_MIN_TPEX_OFFICIAL_ROWS,
  TW_MIN_TWSE_OFFICIAL_ROWS,
} from '@/lib/datasource/eodSettlePolicy';

const IS_VERCEL = !!process.env.VERCEL;
const CACHE_TTL_MS = 60_000;
const CACHE_MISS_TTL_MS = 5_000;

export interface TWOfficialCloseState {
  market: 'TW';
  date: string;
  settledAt: string;
  twseRows: number;
  tpexRows: number;
  /** 官方完整收盤表沒有當日 OHLC row 的純代碼。 */
  noTradeSymbols: string[];
}

let cached: { date: string; loadedAt: number; value: TWOfficialCloseState | null } | null = null;

function key(date: string): string {
  return `reports/official-close-TW-${date}.json`;
}

export function isCompleteTWOfficialCloseState(
  value: TWOfficialCloseState | null | undefined,
  date: string,
): value is TWOfficialCloseState {
  return !!value
    && value.market === 'TW'
    && value.date === date
    && /^\d{4}-\d{2}-\d{2}$/.test(value.date)
    && value.twseRows >= TW_MIN_TWSE_OFFICIAL_ROWS
    && value.tpexRows >= TW_MIN_TPEX_OFFICIAL_ROWS
    && Number.isFinite(new Date(value.settledAt).getTime())
    && Array.isArray(value.noTradeSymbols)
    && value.noTradeSymbols.every(symbol => typeof symbol === 'string' && /^\d{4,6}[A-Z]?$/.test(symbol));
}

export async function saveTWOfficialCloseState(state: TWOfficialCloseState): Promise<void> {
  const stateDate = state.date;
  if (!isCompleteTWOfficialCloseState(state, stateDate)) {
    throw new Error(`TW official close state incomplete for ${stateDate}`);
  }
  const normalized: TWOfficialCloseState = {
    ...state,
    noTradeSymbols: [...new Set(state.noTradeSymbols.map(symbol => symbol.replace(/\.(TW|TWO)$/i, '')))].sort(),
  };
  const json = JSON.stringify(normalized);

  if (IS_VERCEL) {
    const { put } = await import('@vercel/blob');
    await put(key(state.date), json, { access: 'private', addRandomSuffix: false, allowOverwrite: true });
  }

  try {
    const { mkdir } = await import('node:fs/promises');
    const path = await import('node:path');
    const { atomicFsPut } = await import('@/lib/storage/atomicFsPut');
    const dir = path.join(process.cwd(), 'data', 'reports');
    await mkdir(dir, { recursive: true });
    await atomicFsPut(path.join(dir, `official-close-TW-${state.date}.json`), json);
  } catch {
    if (!IS_VERCEL) throw new Error(`無法保存 TW official close state ${state.date}`);
  }
  cached = { date: state.date, loadedAt: Date.now(), value: normalized };
}

export async function readTWOfficialCloseState(date: string): Promise<TWOfficialCloseState | null> {
  const ttl = cached?.value ? CACHE_TTL_MS : CACHE_MISS_TTL_MS;
  if (cached?.date === date && Date.now() - cached.loadedAt < ttl) return cached.value;

  let value: TWOfficialCloseState | null = null;
  try {
    if (IS_VERCEL) {
      const { get } = await import('@vercel/blob');
      const result = await get(key(date), { access: 'private' });
      if (result?.stream) {
        const reader = result.stream.getReader();
        const chunks: Uint8Array[] = [];
        for (;;) {
          const { done, value: chunk } = await reader.read();
          if (done) break;
          if (chunk) chunks.push(chunk);
        }
        value = JSON.parse(new TextDecoder().decode(Buffer.concat(chunks))) as TWOfficialCloseState;
      }
    } else {
      const { readFile } = await import('node:fs/promises');
      const path = await import('node:path');
      value = JSON.parse(await readFile(
        path.join(process.cwd(), 'data', 'reports', `official-close-TW-${date}.json`),
        'utf8',
      )) as TWOfficialCloseState;
    }
  } catch {
    value = null;
  }

  const complete = isCompleteTWOfficialCloseState(value, date) ? value : null;
  cached = { date, loadedAt: Date.now(), value: complete };
  return complete;
}
