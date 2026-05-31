// ============================================================
// 三色資金（台股）— 掃描結果持久化。lib/cn-sanse/scanStorage 的台股 fork。
//   本地 dev：data/tw-sanse-scan/{date}.json
//   Vercel ：Blob prefix tw-sanse-scan/{date}.json
// 自創策略、刻意與書本掃描的 lib/storage/scanStorage 隔離。
// v1 只做盤後封存（無盤中即時，台股三色盤中為後續增強）。
// ============================================================

import type { SanSeScanResult } from '@/lib/cn-sanse/scan';

const IS_VERCEL = !!process.env.VERCEL;
const KEEP_DAYS = 30;
const SUBDIR = 'tw-sanse-scan';

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

/** 固化一日掃描結果（覆寫同日）。
 *  防呆：evaluated===0 = 整個市場都 stale（多半是 ^TWII 落後一天，個股已更新卻對不上 lastDate）→
 *  不存檔，避免空掃覆蓋掉前一次有效結果（對齊鐵律 #1：髒資料不寫盤）。 */
export async function saveTwSanSeScan(result: SanSeScanResult): Promise<void> {
  if (result.evaluated === 0) {
    console.warn(`[tw-sanse] ${result.lastDate} evaluated=0（疑似 ^TWII 落後），跳過存檔`);
    return;
  }
  const data = JSON.stringify(result);
  if (IS_VERCEL) await blobPut(`${SUBDIR}/${result.lastDate}.json`, data);
  else await fsPut(result.lastDate, data);
  pruneOld().catch(() => {});
}

/** 讀某日固化結果；無則 null。 */
export async function loadTwSanSeScan(date: string): Promise<SanSeScanResult | null> {
  const raw = IS_VERCEL ? await blobGet(`${SUBDIR}/${date}.json`) : await fsGet(date);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as SanSeScanResult;
  } catch {
    return null;
  }
}

/** 列出所有已固化日期（新到舊），最多回 KEEP_DAYS 個。 */
export async function listTwSanSeDates(): Promise<SanSeDateEntry[]> {
  const dates = (IS_VERCEL ? await blobListDates() : await fsListDates())
    .sort((a, b) => b.localeCompare(a))
    .slice(0, KEEP_DAYS);
  const out: SanSeDateEntry[] = [];
  for (const date of dates) {
    const r = await loadTwSanSeScan(date);
    if (r) out.push({ date, counts: r.counts, scannedAt: r.scannedAt });
  }
  return out;
}

/** 取最新一個已固化日期；無則 null。 */
export async function latestTwSanSeDate(): Promise<string | null> {
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
