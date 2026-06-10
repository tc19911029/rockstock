/**
 * 消息面 daily digest — 把每日晨報新聞點到的個股，對照「持股 + 法人報告」存成一層訊號。
 *
 * 資料路徑：data/news-digest/{YYYY-MM-DD}.json
 * 來源：使用者每日晨報 docx（電子時報/工商時報/經濟日報），由 scripts/build-news-digest.ts 整理。
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { atomicFsPut } from '@/lib/storage/atomicFsPut';

const IS_VERCEL = !!process.env.VERCEL;
const BLOB_PREFIX = 'broker/news-digest';
const FS_ROOT = path.join(process.cwd(), 'data', 'news-digest');

export type NewsSentiment = 'bullish' | 'bearish' | 'neutral';

export interface NewsMention {
  code: string;
  name: string;
  market: 'TW' | 'CN' | 'OTHER';
  headlines: string[];
  sentiment: NewsSentiment;
  in_holdings: boolean;
  in_broker_reports: boolean;
  /** 該股在法人報告裡的綜合立場（例「花旗升評買進 / 大摩中立」）。 */
  broker_view: string | null;
  /** 新聞 vs 法人立場的交叉訊號（印證 / 矛盾 / 補充）。 */
  cross_signal: string | null;
}

export interface NewsDigest {
  date: string;
  source: string;
  generated_at: string;
  mentions: NewsMention[];
  stats: {
    total: number;
    holdings_hit: number;
    broker_report_hit: number;
    bullish: number;
    bearish: number;
    neutral: number;
  };
}

function key(date: string): string { return `${date}.json`; }

export async function saveNewsDigest(d: NewsDigest): Promise<void> {
  const data = JSON.stringify(d, null, 2);
  if (IS_VERCEL) {
    const { blobPutWithRetry } = await import('@/lib/storage/blobRetry');
    await blobPutWithRetry(`${BLOB_PREFIX}/${key(d.date)}`, data, {
      access: 'private', addRandomSuffix: false, allowOverwrite: true, contentType: 'application/json',
    });
  } else {
    const target = path.join(FS_ROOT, key(d.date));
    await fs.mkdir(path.dirname(target), { recursive: true });
    await atomicFsPut(target, data);
  }
}

export async function loadNewsDigest(date: string): Promise<NewsDigest | null> {
  if (IS_VERCEL) {
    try {
      const { get } = await import('@vercel/blob');
      const res = await get(`${BLOB_PREFIX}/${key(date)}`, { access: 'private' });
      if (!res?.stream) return null;
      const reader = res.stream.getReader(); const chunks: Uint8Array[] = [];
      for (;;) { const { done, value } = await reader.read(); if (done) break; if (value) chunks.push(value); }
      return JSON.parse(new TextDecoder().decode(Buffer.concat(chunks))) as NewsDigest;
    } catch { return null; }
  }
  try {
    return JSON.parse(await fs.readFile(path.join(FS_ROOT, key(date)), 'utf-8')) as NewsDigest;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

export async function listNewsDigestDates(): Promise<string[]> {
  if (IS_VERCEL) {
    try {
      const { list } = await import('@vercel/blob');
      const res = await list({ prefix: `${BLOB_PREFIX}/` });
      return res.blobs.map(b => b.pathname.split('/').pop()?.replace(/\.json$/, '') ?? '')
        .filter(d => /^\d{4}-\d{2}-\d{2}$/.test(d)).sort().reverse();
    } catch { return []; }
  }
  try {
    return (await fs.readdir(FS_ROOT)).map(f => f.replace(/\.json$/, ''))
      .filter(d => /^\d{4}-\d{2}-\d{2}$/.test(d)).sort().reverse();
  } catch { return []; }
}
