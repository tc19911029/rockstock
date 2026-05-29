// ============================================================
// 三色資金 — 掃描結果持久化（自創策略，刻意與 TW lib/storage/scanStorage 隔離）
//
// 複合主鍵僅需 date（cn-sanse 單一策略、無 direction/mtf 維度）。
//   本地 dev：data/cn-sanse-scan/{date}.json
//   Vercel ：Blob prefix cn-sanse-scan/{date}.json
// ============================================================

import type { SanSeScanResult } from './scan';

const IS_VERCEL = !!process.env.VERCEL;
const KEEP_DAYS = 30;
const SUBDIR = 'cn-sanse-scan';
// 盤中即時掃描快照：刻意與盤後封存（SUBDIR）分檔，避免盤中半根量蓋掉封存版（鐵律 #1/#4）。
// 同日盤中多輪互相覆寫（latest live wins）；非封存，不進 KEEP_DAYS 計算。
const SUBDIR_INTRADAY = 'cn-sanse-scan-intraday';

export interface SanSeDateEntry {
  date: string;
  counts: SanSeScanResult['counts'];
  scannedAt: string;
}

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

async function blobListDates(): Promise<string[]> {
  const { list: blobList } = await import('@vercel/blob');
  const out: string[] = [];
  let cursor: string | undefined;
  do {
    const result = await blobList({ prefix: `${SUBDIR}/`, limit: 100, cursor });
    for (const b of result.blobs) {
      const m = b.pathname.match(/(\d{4}-\d{2}-\d{2})\.json$/);
      if (m) out.push(m[1]);
    }
    cursor = result.hasMore ? result.cursor : undefined;
  } while (cursor);
  return out;
}

// ── Filesystem ────────────────────────────────────────────────────────────────
async function fsDir(): Promise<string> {
  const { promises: fs } = await import('fs');
  const path = await import('path');
  const dir = path.join(process.cwd(), 'data', SUBDIR);
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

async function fsPut(date: string, data: string): Promise<void> {
  const path = await import('path');
  const { atomicFsPut } = await import('@/lib/storage/atomicFsPut');
  await atomicFsPut(path.join(await fsDir(), `${date}.json`), data);
}

async function fsGet(date: string): Promise<string | null> {
  const { promises: fs } = await import('fs');
  const path = await import('path');
  try {
    return await fs.readFile(path.join(process.cwd(), 'data', SUBDIR, `${date}.json`), 'utf-8');
  } catch {
    return null;
  }
}

async function fsListDates(): Promise<string[]> {
  const { promises: fs } = await import('fs');
  try {
    const files = await fs.readdir(await fsDir());
    return files.filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f)).map((f) => f.replace('.json', ''));
  } catch {
    return [];
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

/** 固化一日掃描結果（覆寫同日）。 */
export async function saveSanSeScan(result: SanSeScanResult): Promise<void> {
  const data = JSON.stringify(result);
  if (IS_VERCEL) await blobPut(`${SUBDIR}/${result.lastDate}.json`, data);
  else await fsPut(result.lastDate, data);
  pruneOld().catch(() => {});
}

/** 讀某日固化結果；無則 null。 */
export async function loadSanSeScan(date: string): Promise<SanSeScanResult | null> {
  const raw = IS_VERCEL ? await blobGet(`${SUBDIR}/${date}.json`) : await fsGet(date);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as SanSeScanResult;
  } catch {
    return null;
  }
}

// ── 盤中即時快照（分檔，不碰盤後封存）─────────────────────────────────────────

// 盤中快照無回看價值（隔日就被當日盤後封存取代），保留天數比封存短。
const INTRADAY_KEEP_DAYS = 7;

/** 寫盤中即時掃描快照（同日覆寫，latest live wins）。刻意分檔，不影響盤後封存。 */
export async function saveSanSeIntraday(result: SanSeScanResult): Promise<void> {
  const data = JSON.stringify(result);
  if (IS_VERCEL) {
    await blobPut(`${SUBDIR_INTRADAY}/${result.lastDate}.json`, data);
  } else {
    const path = await import('path');
    const { promises: fs } = await import('fs');
    const { atomicFsPut } = await import('@/lib/storage/atomicFsPut');
    const dir = path.join(process.cwd(), 'data', SUBDIR_INTRADAY);
    await fs.mkdir(dir, { recursive: true });
    await atomicFsPut(path.join(dir, `${result.lastDate}.json`), data);
  }
  pruneIntraday().catch(() => {});
}

/** 清理過舊的盤中快照（保留最近 INTRADAY_KEEP_DAYS 天）。 */
async function pruneIntraday(): Promise<void> {
  let dates: string[] = [];
  if (IS_VERCEL) {
    const { list: blobList } = await import('@vercel/blob');
    let cursor: string | undefined;
    do {
      const result = await blobList({ prefix: `${SUBDIR_INTRADAY}/`, limit: 100, cursor });
      for (const b of result.blobs) {
        const m = b.pathname.match(/(\d{4}-\d{2}-\d{2})\.json$/);
        if (m) dates.push(m[1]);
      }
      cursor = result.hasMore ? result.cursor : undefined;
    } while (cursor);
  } else {
    const { promises: fs } = await import('fs');
    const path = await import('path');
    const files = await fs.readdir(path.join(process.cwd(), 'data', SUBDIR_INTRADAY)).catch(() => [] as string[]);
    dates = files.filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f)).map((f) => f.replace('.json', ''));
  }
  const stale = dates.sort((a, b) => b.localeCompare(a)).slice(INTRADAY_KEEP_DAYS);
  if (!stale.length) return;
  if (IS_VERCEL) {
    const { del } = await import('@vercel/blob');
    await Promise.all(stale.map((d) => del(`${SUBDIR_INTRADAY}/${d}.json`).catch(() => {})));
  } else {
    const { promises: fs } = await import('fs');
    const path = await import('path');
    const dir = path.join(process.cwd(), 'data', SUBDIR_INTRADAY);
    await Promise.all(stale.map((d) => fs.unlink(path.join(dir, `${d}.json`)).catch(() => {})));
  }
}

/** 讀某日盤中即時快照；無則 null。 */
export async function loadSanSeIntraday(date: string): Promise<SanSeScanResult | null> {
  let raw: string | null = null;
  if (IS_VERCEL) {
    raw = await blobGet(`${SUBDIR_INTRADAY}/${date}.json`);
  } else {
    const path = await import('path');
    const { promises: fs } = await import('fs');
    raw = await fs.readFile(path.join(process.cwd(), 'data', SUBDIR_INTRADAY, `${date}.json`), 'utf-8').catch(() => null);
  }
  if (!raw) return null;
  try {
    return JSON.parse(raw) as SanSeScanResult;
  } catch {
    return null;
  }
}

/** 取最新一個有盤中即時快照的日期；無則 null。 */
export async function latestSanSeIntradayDate(): Promise<string | null> {
  let dates: string[] = [];
  if (IS_VERCEL) {
    const { list: blobList } = await import('@vercel/blob');
    let cursor: string | undefined;
    do {
      const result = await blobList({ prefix: `${SUBDIR_INTRADAY}/`, limit: 100, cursor });
      for (const b of result.blobs) {
        const m = b.pathname.match(/(\d{4}-\d{2}-\d{2})\.json$/);
        if (m) dates.push(m[1]);
      }
      cursor = result.hasMore ? result.cursor : undefined;
    } while (cursor);
  } else {
    const { promises: fs } = await import('fs');
    const path = await import('path');
    const files = await fs.readdir(path.join(process.cwd(), 'data', SUBDIR_INTRADAY)).catch(() => [] as string[]);
    dates = files.filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f)).map((f) => f.replace('.json', ''));
  }
  dates.sort((a, b) => b.localeCompare(a));
  return dates[0] ?? null;
}

/** 列出所有已固化日期（新到舊），最多回 KEEP_DAYS 個。 */
export async function listSanSeDates(): Promise<SanSeDateEntry[]> {
  const dates = (IS_VERCEL ? await blobListDates() : await fsListDates())
    .sort((a, b) => b.localeCompare(a))
    .slice(0, KEEP_DAYS);
  const out: SanSeDateEntry[] = [];
  for (const date of dates) {
    const r = await loadSanSeScan(date);
    if (r) out.push({ date, counts: r.counts, scannedAt: r.scannedAt });
  }
  return out;
}

/** 取最新一個已固化日期；無則 null。 */
export async function latestSanSeDate(): Promise<string | null> {
  const dates = (IS_VERCEL ? await blobListDates() : await fsListDates()).sort((a, b) => b.localeCompare(a));
  return dates[0] ?? null;
}

async function pruneOld(): Promise<void> {
  const dates = (IS_VERCEL ? await blobListDates() : await fsListDates()).sort((a, b) => b.localeCompare(a));
  const stale = dates.slice(KEEP_DAYS);
  if (!stale.length) return;
  if (IS_VERCEL) {
    const { del } = await import('@vercel/blob');
    await Promise.all(stale.map((d) => del(`${SUBDIR}/${d}.json`).catch(() => {})));
  } else {
    const { promises: fs } = await import('fs');
    const path = await import('path');
    const dir = path.join(process.cwd(), 'data', SUBDIR);
    await Promise.all(stale.map((d) => fs.unlink(path.join(dir, `${d}.json`)).catch(() => {})));
  }
}
