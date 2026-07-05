/**
 * 鎖股 roster 儲存（批次D 2026-07-05）— FS 主、Vercel Blob 鏡像（同 lockWatchStorage 慣例）
 *
 * 路徑：
 *   roster:  data/lockwatch-roster/{market}/roster.json         （現行名單，單一檔覆寫）
 *   review:  data/lockwatch-roster/{market}/reviews/{date}.json （每日汰弱紀錄，append-only）
 */
import path from 'path';
import type { MarketId } from '@/lib/scanner/types';
import type { LockRoster, RosterReview } from '@/lib/scanner/lockRoster';

const IS_VERCEL = !!process.env.VERCEL;

async function blobPut(pathname: string, data: string): Promise<void> {
  const { blobPutWithRetry } = await import('@/lib/storage/blobRetry');
  await blobPutWithRetry(pathname, data, {
    access: 'public', addRandomSuffix: false, contentType: 'application/json',
    allowOverwrite: true,
  });
}

async function blobGet(pathname: string): Promise<string | null> {
  try {
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
  } catch { return null; }
}

function rosterFsPath(market: MarketId): string {
  return path.join(process.cwd(), 'data', 'lockwatch-roster', market, 'roster.json');
}
function reviewFsPath(market: MarketId, date: string): string {
  return path.join(process.cwd(), 'data', 'lockwatch-roster', market, 'reviews', `${date}.json`);
}

async function fsWrite(fullPath: string, data: string): Promise<void> {
  const { promises: fs } = await import('fs');
  await fs.mkdir(path.dirname(fullPath), { recursive: true });
  const tmp = `${fullPath}.tmp`;
  await fs.writeFile(tmp, data, 'utf-8');
  await fs.rename(tmp, fullPath);
}

async function fsRead(fullPath: string): Promise<string | null> {
  const { promises: fs } = await import('fs');
  try { return await fs.readFile(fullPath, 'utf-8'); } catch { return null; }
}

export async function saveLockRoster(roster: LockRoster): Promise<void> {
  const data = JSON.stringify(roster, null, 2);
  if (IS_VERCEL) await blobPut(`lockwatch-roster/${roster.market}/roster.json`, data);
  else await fsWrite(rosterFsPath(roster.market), data);
}

export async function loadLockRoster(market: MarketId): Promise<LockRoster | null> {
  const raw = IS_VERCEL
    ? await blobGet(`lockwatch-roster/${market}/roster.json`)
    : await fsRead(rosterFsPath(market));
  if (!raw) return null;
  try { return JSON.parse(raw) as LockRoster; } catch { return null; }
}

export async function saveRosterReview(review: RosterReview): Promise<void> {
  const data = JSON.stringify(review, null, 2);
  if (IS_VERCEL) await blobPut(`lockwatch-roster/${review.market}/reviews/${review.date}.json`, data);
  else await fsWrite(reviewFsPath(review.market, review.date), data);
}

export async function loadRosterReview(market: MarketId, date: string): Promise<RosterReview | null> {
  const raw = IS_VERCEL
    ? await blobGet(`lockwatch-roster/${market}/reviews/${date}.json`)
    : await fsRead(reviewFsPath(market, date));
  if (!raw) return null;
  try { return JSON.parse(raw) as RosterReview; } catch { return null; }
}

/** 最近 N 天 review（汰弱歷史，FS only；Vercel 端 UI 只看 roster + 當日 review） */
export async function listRecentReviews(market: MarketId, limit = 10): Promise<RosterReview[]> {
  if (IS_VERCEL) return [];
  const { promises: fs } = await import('fs');
  const dir = path.join(process.cwd(), 'data', 'lockwatch-roster', market, 'reviews');
  try {
    const files = (await fs.readdir(dir)).filter(f => /^\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort().reverse().slice(0, limit);
    const out: RosterReview[] = [];
    for (const f of files) {
      const raw = await fsRead(path.join(dir, f));
      if (raw) { try { out.push(JSON.parse(raw)); } catch { /* skip */ } }
    }
    return out;
  } catch { return []; }
}
