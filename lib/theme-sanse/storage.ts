// ============================================================
// 題材×三色 — dual-storage 持久化層（隔離 data/theme-sanse/）。
//
// 鏡像 lib/cn-agents/storage.ts：本地 data/theme-sanse/{market}/{domain}/{date}.json，
// Vercel Blob key theme-sanse/{market}/{domain}/{date}.json。market 子目錄分流 TW/CN。
//   events      — 三組事件日檔（ThemeSanseEventsFile）
//   daily       — 每日 UI 快照（ThemeSanseDaily）
//   leaderboard — 三組對照回測快照（market 層單檔，非日檔）
//
// 防呆（仿 cn-sanse saveSanSeScan DF8 / cn-agents saveRecoEvents）：
//   - 日期非 YYYY-MM-DD → throw（檔名即主鍵，髒日期=讀不到的孤兒檔）
//   - 事件檔 events 為空 → throw（退化資料，避免空檔覆蓋好檔）
//   - 事件 id 重複 → throw（複合主鍵唯一性最後防線）
// ============================================================

import type { CohortComparisonSnapshot } from './stats';
import type { ThemeSanseDaily, ThemeSanseEventsFile, TsMarket } from './types';

const IS_VERCEL = !!process.env.VERCEL;
const ROOT = 'theme-sanse';

type Domain = 'events' | 'daily';

// ── Vercel Blob ───────────────────────────────────────────────────────────────

async function blobPut(pathname: string, data: string): Promise<void> {
  const { blobPutWithRetry } = await import('@/lib/storage/blobRetry');
  await blobPutWithRetry(pathname, data, { access: 'private', addRandomSuffix: false, allowOverwrite: true });
}

async function blobGet(pathname: string): Promise<string | null> {
  const { get } = await import('@vercel/blob');
  const result = await get(pathname, { access: 'private' }).catch(() => null);
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

async function blobListDates(prefix: string): Promise<string[]> {
  const { list: blobList } = await import('@vercel/blob');
  const out: string[] = [];
  let cursor: string | undefined;
  do {
    const result = await blobList({ prefix, limit: 100, cursor });
    for (const b of result.blobs) {
      const m = b.pathname.match(/(\d{4}-\d{2}-\d{2})\.json$/);
      if (m) out.push(m[1]);
    }
    cursor = result.hasMore ? result.cursor : undefined;
  } while (cursor);
  return out.sort();
}

// ── Filesystem ────────────────────────────────────────────────────────────────

function relDir(market: TsMarket, domain: Domain): string[] {
  return ['data', ROOT, market, domain];
}

async function fsPut(market: TsMarket, domain: Domain, filename: string, data: string): Promise<void> {
  const path = await import('path');
  const { promises: fs } = await import('fs');
  const { atomicFsPut } = await import('@/lib/storage/atomicFsPut');
  const dir = path.join(process.cwd(), ...relDir(market, domain));
  await fs.mkdir(dir, { recursive: true });
  await atomicFsPut(path.join(dir, filename), data);
}

async function fsGet(market: TsMarket, domain: Domain, filename: string): Promise<string | null> {
  const path = await import('path');
  const { promises: fs } = await import('fs');
  return fs.readFile(path.join(process.cwd(), ...relDir(market, domain), filename), 'utf-8').catch(() => null);
}

async function fsListDates(market: TsMarket, domain: Domain): Promise<string[]> {
  const path = await import('path');
  const { promises: fs } = await import('fs');
  const files = await fs.readdir(path.join(process.cwd(), ...relDir(market, domain))).catch(() => [] as string[]);
  return files.filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f)).map((f) => f.slice(0, 10)).sort();
}

// ── 泛型 domain 日檔讀寫 ──────────────────────────────────────────────────────

async function putJson(market: TsMarket, domain: Domain, filename: string, payload: unknown): Promise<void> {
  const data = JSON.stringify(payload);
  if (IS_VERCEL) await blobPut(`${ROOT}/${market}/${domain}/${filename}`, data);
  else await fsPut(market, domain, filename, data);
}

async function getJson<T>(market: TsMarket, domain: Domain, filename: string): Promise<T | null> {
  const raw = IS_VERCEL ? await blobGet(`${ROOT}/${market}/${domain}/${filename}`) : await fsGet(market, domain, filename);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null; // 壞檔（寫入中斷殘骸）視同不存在
  }
}

async function listDates(market: TsMarket, domain: Domain): Promise<string[]> {
  return IS_VERCEL ? blobListDates(`${ROOT}/${market}/${domain}/`) : fsListDates(market, domain);
}

// ── market 層單檔（leaderboard 快照） ─────────────────────────────────────────

async function putMarketFile(market: TsMarket, filename: string, payload: unknown): Promise<void> {
  const data = JSON.stringify(payload);
  if (IS_VERCEL) { await blobPut(`${ROOT}/${market}/${filename}`, data); return; }
  const path = await import('path');
  const { promises: fs } = await import('fs');
  const { atomicFsPut } = await import('@/lib/storage/atomicFsPut');
  const dir = path.join(process.cwd(), 'data', ROOT, market);
  await fs.mkdir(dir, { recursive: true });
  await atomicFsPut(path.join(dir, filename), data);
}

async function getMarketFile<T>(market: TsMarket, filename: string): Promise<T | null> {
  let raw: string | null;
  if (IS_VERCEL) raw = await blobGet(`${ROOT}/${market}/${filename}`);
  else {
    const path = await import('path');
    const { promises: fs } = await import('fs');
    raw = await fs.readFile(path.join(process.cwd(), 'data', ROOT, market, filename), 'utf-8').catch(() => null);
  }
  if (!raw) return null;
  try { return JSON.parse(raw) as T; } catch { return null; }
}

// ── 事件日檔 ──────────────────────────────────────────────────────────────────

export async function saveThemeSanseEvents(file: ThemeSanseEventsFile): Promise<void> {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(file.date)) {
    throw new Error(`[theme-sanse] saveThemeSanseEvents 非法日期 '${file.date}'`);
  }
  if (file.events.length === 0) {
    throw new Error(`[theme-sanse] ${file.market} ${file.date} 事件為空，拒絕存檔（退化資料，避免覆蓋好檔）`);
  }
  const seen = new Set<string>();
  for (const e of file.events) {
    if (seen.has(e.id)) throw new Error(`[theme-sanse] saveThemeSanseEvents ${file.date} 重複事件 id：${e.id}`);
    seen.add(e.id);
  }
  await putJson(file.market, 'events', `${file.date}.json`, file);
}

export async function readThemeSanseEvents(market: TsMarket, date: string): Promise<ThemeSanseEventsFile | null> {
  return getJson<ThemeSanseEventsFile>(market, 'events', `${date}.json`);
}

export async function listThemeSanseEventDates(market: TsMarket): Promise<string[]> {
  return listDates(market, 'events');
}

// ── 每日快照 ──────────────────────────────────────────────────────────────────

export async function saveThemeSanseDaily(daily: ThemeSanseDaily): Promise<void> {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(daily.date)) {
    throw new Error(`[theme-sanse] saveThemeSanseDaily 非法日期 '${daily.date}'`);
  }
  await putJson(daily.market, 'daily', `${daily.date}.json`, daily);
}

export async function readThemeSanseDaily(market: TsMarket, date: string): Promise<ThemeSanseDaily | null> {
  return getJson<ThemeSanseDaily>(market, 'daily', `${date}.json`);
}

export async function listThemeSanseDailyDates(market: TsMarket): Promise<string[]> {
  return listDates(market, 'daily');
}

// ── 三組對照回測快照（market 層單檔） ────────────────────────────────────────

export async function saveCohortSnapshot(snap: CohortComparisonSnapshot): Promise<void> {
  await putMarketFile(snap.market, 'leaderboard.json', snap);
}

export async function readCohortSnapshot(market: TsMarket): Promise<CohortComparisonSnapshot | null> {
  return getMarketFile<CohortComparisonSnapshot>(market, 'leaderboard.json');
}
