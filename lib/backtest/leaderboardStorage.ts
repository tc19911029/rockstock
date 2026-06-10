/**
 * 策略排行榜 storage — 讀取 harness（scripts/backtest-unified-leaderboard.ts）產出的
 * 單一文件 data/backtest/strategy-leaderboard.json（含 TW + CN 全部列）。
 *
 * 讀取：本地 fs 優先，Vercel 上 fallback Blob（同 fundamental-revaluation/storage 慣例）。
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import type { LeaderboardDoc } from './leaderboardTypes';

const LOCAL = path.join(process.cwd(), 'data', 'backtest', 'strategy-leaderboard.json');
const BLOB_KEY = 'backtest/strategy-leaderboard.json';
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

export async function loadLeaderboard(): Promise<LeaderboardDoc | null> {
  try {
    const raw = await fs.readFile(LOCAL, 'utf-8');
    return JSON.parse(raw) as LeaderboardDoc;
  } catch {
    const raw = await blobGetMaybe(BLOB_KEY);
    if (!raw) return null;
    try {
      return JSON.parse(raw) as LeaderboardDoc;
    } catch {
      return null;
    }
  }
}
