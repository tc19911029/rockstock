/**
 * 誠實 edge 讀檔（IO）— 與 edgeRating.ts（純）分離，讓 client 能安全 import 純模組。
 * 來源：scripts/compute-honest-edge.ts 產出 data/backtest/honest-edge-ranking.json。
 * 讀取：本地 fs 優先，Vercel 上 fallback Blob（同 leaderboardStorage 慣例）。
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import type { HonestEdgeDoc } from './edgeRating';

const LOCAL = path.join(process.cwd(), 'data', 'backtest', 'honest-edge-ranking.json');
const BLOB_KEY = 'backtest/honest-edge-ranking.json';
const IS_VERCEL = !!process.env.VERCEL;

async function blobGetMaybe(blobPath: string): Promise<string | null> {
  if (!IS_VERCEL) return null;
  try {
    const { head } = await import('@vercel/blob');
    const meta = await head(blobPath);
    if (!meta) return null;
    const res = await fetch(meta.url);
    if (!res.ok) return null;
    return await res.text();
  } catch {
    return null;
  }
}

export async function loadHonestEdge(): Promise<HonestEdgeDoc | null> {
  let raw: string | null = null;
  try {
    raw = await fs.readFile(LOCAL, 'utf-8');
  } catch {
    raw = await blobGetMaybe(BLOB_KEY);
  }
  if (!raw) return null;
  try {
    return JSON.parse(raw) as HonestEdgeDoc;
  } catch {
    return null;
  }
}
