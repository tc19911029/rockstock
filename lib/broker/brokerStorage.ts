/**
 * 法人報告儲存層（dual-storage：Vercel Blob + 本地 fs）。
 *
 * 結構照 lib/youtube/analysisStorage.ts（同一套 blob/fs helper），換 prefix='broker'。
 * 路徑：
 *   reports/{YYYY-MM-DD}.json  — 某日所有報告（BrokerDailyReports）
 *   index.json                 — 有資料的日期清單（降冪）
 *   brokers.json               — 券商 registry（缺檔回 DEFAULT_BROKERS）
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { atomicFsPut } from '@/lib/storage/atomicFsPut';
import type { BrokerDailyReports, BrokerRegistryEntry, BrokerReport } from './types';

const IS_VERCEL = !!process.env.VERCEL;
const BLOB_PREFIX = 'broker';
const FS_ROOT = path.join(process.cwd(), 'data', 'broker');

/** 券商 registry 預設值（檔名 hint → 顯示名 + 預設幣別）。 */
export const DEFAULT_BROKERS: BrokerRegistryEntry[] = [
  { key: 'gs', display: '高盛', aliases: ['gs', 'goldman', 'goldman sachs'], default_currency: 'TWD' },
  { key: 'ms', display: '大摩', aliases: ['ms', 'morgan', 'morgan stanley'], default_currency: 'TWD' },
  { key: 'citi', display: '花旗', aliases: ['citi', 'citigroup', 'citibank'], default_currency: 'TWD' },
  { key: 'ubs', display: '瑞銀', aliases: ['ubs'], default_currency: 'TWD' },
  { key: 'daiwa', display: '大和', aliases: ['daiwa', 'daiwa-cathay', 'dwa'], default_currency: 'TWD' },
  { key: 'jpm', display: '小摩', aliases: ['jpm', 'jpmorgan', 'jp morgan'], default_currency: 'TWD' },
  { key: 'bofa', display: '美銀', aliases: ['bofa', 'baml', 'merrill'], default_currency: 'TWD' },
  { key: 'nomura', display: '野村', aliases: ['nomura'], default_currency: 'TWD' },
  { key: 'macquarie', display: '麥格理', aliases: ['macquarie', 'mq'], default_currency: 'TWD' },
  { key: 'cls', display: '里昂', aliases: ['cls', 'clsa'], default_currency: 'TWD' },
  { key: 'jefferies', display: '傑富瑞', aliases: ['jefferies', 'jef'], default_currency: 'TWD' },
  { key: 'hsbc', display: '滙豐', aliases: ['hsbc'], default_currency: 'TWD' },
  { key: 'mizuho', display: '瑞穗', aliases: ['mizuho'], default_currency: 'JPY' },
  { key: 'smbcnikko', display: 'SMBC日興', aliases: ['smbcnikko', 'smbc nikko', 'smbc', 'nikko'], default_currency: 'JPY' },
  { key: 'deutschebank', display: '德意志', aliases: ['deutschebank', 'deutsche bank', 'deutsche', 'db'], default_currency: 'USD' },
  { key: 'morningstar', display: '晨星', aliases: ['morningstar', 'mstar'], default_currency: 'USD' },
  { key: 'wellsfargo', display: '富國', aliases: ['wellsfargo', 'wells fargo', 'wfc'], default_currency: 'USD' },
  { key: 'barclays', display: '巴克萊', aliases: ['barclays', 'barc'], default_currency: 'USD' },
  { key: 'stifel', display: 'Stifel', aliases: ['stifel'], default_currency: 'USD' },
  { key: 'aletheia', display: 'Aletheia', aliases: ['aletheia', 'aletheia capital', 'tag'], default_currency: 'TWD' },
  // 本土券商
  { key: 'kgi', display: '凱基', aliases: ['kgi', '凱基', '凱基投顧'], default_currency: 'TWD' },
  { key: 'fubon', display: '富邦', aliases: ['fubon', '富邦', '富邦投顧'], default_currency: 'TWD' },
  { key: 'ctbc', display: '中信', aliases: ['ctbc', '中信', '中信投顧'], default_currency: 'TWD' },
  { key: 'sinopac', display: '永豐', aliases: ['sinopac', '永豐', '永豐投顧'], default_currency: 'TWD' },
  { key: 'masterlink', display: '元富', aliases: ['masterlink', '元富', '元富投顧'], default_currency: 'TWD' },
  { key: 'yuanta', display: '元大', aliases: ['yuanta', '元大', '元大投顧', '元大證券'], default_currency: 'TWD' },
];

// ── blob/fs helper（照 analysisStorage.ts）─────────────────────────────────────

function blobPath(key: string): string { return `${BLOB_PREFIX}/${key}`; }
function fsPath(key: string): string { return path.join(FS_ROOT, key); }

async function blobPut(key: string, data: string): Promise<void> {
  const { blobPutWithRetry } = await import('@/lib/storage/blobRetry');
  await blobPutWithRetry(blobPath(key), data, {
    access: 'private', addRandomSuffix: false, allowOverwrite: true,
    contentType: 'application/json',
  });
}

async function blobGet(key: string): Promise<string | null> {
  try {
    const { get } = await import('@vercel/blob');
    const result = await get(blobPath(key), { access: 'private' });
    if (!result || !result.stream) return null;
    const reader = result.stream.getReader();
    const chunks: Uint8Array[] = [];
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) chunks.push(value);
    }
    return new TextDecoder().decode(Buffer.concat(chunks));
  } catch { return null; }
}

async function fsPut(key: string, data: string): Promise<void> {
  const target = fsPath(key);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await atomicFsPut(target, data);
}

async function fsGet(key: string): Promise<string | null> {
  try { return await fs.readFile(fsPath(key), 'utf-8'); }
  catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

async function putJson<T>(key: string, value: T): Promise<void> {
  const data = JSON.stringify(value, null, 2);
  if (IS_VERCEL) await blobPut(key, data); else await fsPut(key, data);
}

async function getJson<T>(key: string): Promise<T | null> {
  const raw = IS_VERCEL ? await blobGet(key) : await fsGet(key);
  if (!raw) return null;
  try { return JSON.parse(raw) as T; }
  catch (err) {
    console.error(`[brokerStorage] parse failed ${key}:`, err);
    return null;
  }
}

// ── stats ─────────────────────────────────────────────────────────────────────

function recomputeStats(reports: BrokerReport[]): BrokerDailyReports['stats'] {
  const brokers = new Set<string>();
  const stocks = new Set<string>();
  let covered = 0;
  for (const r of reports) {
    brokers.add(r.broker);
    for (const s of r.stocks) {
      if (s.matched) stocks.add(s.matched.code);
      if (s.covered) covered += 1;
    }
  }
  return {
    report_count: reports.length,
    unique_brokers: brokers.size,
    unique_stocks: stocks.size,
    covered_count: covered,
  };
}

// ── public ──────────────────────────────────────────────────────────────────

function reportsKey(date: string): string { return `reports/${date}.json`; }

export async function loadDailyReports(date: string): Promise<BrokerDailyReports | null> {
  return await getJson<BrokerDailyReports>(reportsKey(date));
}

export async function saveDailyReports(d: BrokerDailyReports): Promise<void> {
  const payload: BrokerDailyReports = { ...d, stats: recomputeStats(d.reports) };
  await putJson(reportsKey(d.date), payload);
  // 更新 index（best-effort）
  try {
    const dates = new Set(await listReportDates());
    dates.add(d.date);
    await putJson('index.json', { dates: Array.from(dates).sort().reverse() });
  } catch { /* index 失敗不阻擋寫報告 */ }
}

export async function listReportDates(): Promise<string[]> {
  const idx = await getJson<{ dates: string[] }>('index.json');
  if (idx?.dates?.length) return idx.dates;
  return await rebuildIndex();
}

export async function rebuildIndex(): Promise<string[]> {
  let dates: string[] = [];
  if (IS_VERCEL) {
    try {
      const { list } = await import('@vercel/blob');
      const res = await list({ prefix: `${BLOB_PREFIX}/reports/` });
      dates = res.blobs
        .map(b => b.pathname.split('/').pop()?.replace(/\.json$/, '') ?? '')
        .filter(d => /^\d{4}-\d{2}-\d{2}$/.test(d));
    } catch { dates = []; }
  } else {
    try {
      const entries = await fs.readdir(path.join(FS_ROOT, 'reports'));
      dates = entries
        .map(f => f.replace(/\.json$/, ''))
        .filter(d => /^\d{4}-\d{2}-\d{2}$/.test(d));
    } catch { dates = []; }
  }
  dates.sort().reverse();
  await putJson('index.json', { dates });
  return dates;
}

export async function loadBrokerRegistry(): Promise<BrokerRegistryEntry[]> {
  const reg = await getJson<BrokerRegistryEntry[]>('brokers.json');
  return reg && reg.length ? reg : DEFAULT_BROKERS;
}

export async function saveBrokerRegistry(entries: BrokerRegistryEntry[]): Promise<void> {
  await putJson('brokers.json', entries);
}

/** 讀某日期區間（含端點）所有報告，給 scorecard / 共識用。 */
export async function loadReportsInRange(start: string, end: string): Promise<BrokerDailyReports[]> {
  const dates = (await listReportDates()).filter(d => d >= start && d <= end);
  const out: BrokerDailyReports[] = [];
  for (const d of dates) {
    const day = await loadDailyReports(d);
    if (day) out.push(day);
  }
  return out;
}
