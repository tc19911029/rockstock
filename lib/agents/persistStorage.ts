/**
 * Agents persist storage — Vercel Blob + 本地 FS dual-storage（IS_VERCEL flag 二選一）
 *
 * 為什麼：
 *   - 原本 poolStorage.ts、orchestrator.ts persist 區、decisions API 都只寫/讀本地 FS
 *   - 結果：Vercel 上的 cron 寫到 pod 的 ephemeral FS，cold start 就消失，user 永遠看不到
 *   - 對齊 scanStorage / youtube analysisStorage pattern：IS_VERCEL ? Blob : FS（互斥）
 *
 * 範圍：
 *   - agents/pool/{market}/{date}.json
 *   - agents/runs/{date}/{symbol}/{filename}.json（_meta.json, _phase.json, technical.json, ...）
 *   - 不含 /tmp/rockstock-agents/（ephemeral question/answer，本來就是 skill 讀寫，無需 Blob）
 */

import path from 'node:path';
import { promises as fs } from 'node:fs';
import { atomicFsPut } from '@/lib/storage/atomicFsPut';

const IS_VERCEL = !!process.env.VERCEL;
const FS_ROOT = path.join(process.cwd(), 'data');

if (IS_VERCEL && !process.env.BLOB_READ_WRITE_TOKEN) {
  console.error('[persistStorage] BLOB_READ_WRITE_TOKEN 未設定，Blob 操作將失敗。請至 Vercel Dashboard → Storage 建立 Blob Store 並連接專案');
}

// ────────────────────────────────────────────────────────────────────────────
// Blob helpers（lazy import @vercel/blob 避免 local 環境也載入）
// ────────────────────────────────────────────────────────────────────────────

async function blobPut(key: string, data: string): Promise<void> {
  const { blobPutWithRetry } = await import('@/lib/storage/blobRetry');
  await blobPutWithRetry(key, data, {
    access: 'private',
    addRandomSuffix: false,
    allowOverwrite: true,
    contentType: 'application/json',
  });
}

async function blobGet(key: string): Promise<string | null> {
  try {
    const { get } = await import('@vercel/blob');
    const result = await get(key, { access: 'private' });
    if (!result || !result.stream) return null;
    const reader = result.stream.getReader();
    const chunks: Uint8Array[] = [];
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) chunks.push(value);
    }
    return new TextDecoder().decode(Buffer.concat(chunks));
  } catch {
    return null;
  }
}

async function blobListPrefix(prefix: string): Promise<string[]> {
  try {
    const { list: blobList } = await import('@vercel/blob');
    const all: string[] = [];
    let cursor: string | undefined;
    do {
      const result = await blobList({ prefix, limit: 100, cursor });
      all.push(...result.blobs.map(b => b.pathname));
      cursor = result.hasMore ? result.cursor : undefined;
    } while (cursor);
    return all;
  } catch {
    return [];
  }
}

async function blobDelete(key: string): Promise<void> {
  try {
    const { del } = await import('@vercel/blob');
    await del(key);
  } catch {
    /* swallow */
  }
}

// ────────────────────────────────────────────────────────────────────────────
// FS helpers
// ────────────────────────────────────────────────────────────────────────────

async function fsPut(relPath: string, data: string): Promise<void> {
  const full = path.join(FS_ROOT, relPath);
  await fs.mkdir(path.dirname(full), { recursive: true });
  await atomicFsPut(full, data);
}

async function fsGet(relPath: string): Promise<string | null> {
  try {
    return await fs.readFile(path.join(FS_ROOT, relPath), 'utf-8');
  } catch {
    return null;
  }
}

async function fsListSubdirs(relPath: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(path.join(FS_ROOT, relPath), { withFileTypes: true });
    return entries.filter(e => e.isDirectory()).map(e => e.name);
  } catch {
    return [];
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Public API
// ────────────────────────────────────────────────────────────────────────────

/**
 * 寫一個 JSON 到 agents persist 區。
 * key 是相對 `data/` 的 path，例如 'agents/pool/TW/2026-05-22.json'
 * 或 'agents/runs/2026-05-22/2330.TW/technical.json'。
 */
export async function agentsPut<T>(key: string, value: T): Promise<void> {
  const data = JSON.stringify(value, null, 2);
  if (IS_VERCEL) await blobPut(key, data);
  else await fsPut(key, data);
}

/** Raw string put（給 orchestrator persistAgentAnswer copy 用，不重新 stringify）*/
export async function agentsPutRaw(key: string, data: string): Promise<void> {
  if (IS_VERCEL) await blobPut(key, data);
  else await fsPut(key, data);
}

export async function agentsGet<T>(key: string): Promise<T | null> {
  const raw = IS_VERCEL ? await blobGet(key) : await fsGet(key);
  if (!raw) return null;
  try { return JSON.parse(raw) as T; }
  catch { return null; }
}

export async function agentsGetRaw(key: string): Promise<string | null> {
  return IS_VERCEL ? await blobGet(key) : await fsGet(key);
}

/**
 * 列出某 prefix 下的所有 key。
 * 例如 prefix='agents/runs/2026-05-22/' 會列出該日所有 run 的 keys。
 * 注意：Vercel Blob list 回的是完整 pathname；FS 端我們合成同樣語意。
 */
export async function agentsListPrefix(prefix: string): Promise<string[]> {
  if (IS_VERCEL) return await blobListPrefix(prefix);
  // FS 走遞迴列舉
  const out: string[] = [];
  async function walk(rel: string): Promise<void> {
    const full = path.join(FS_ROOT, rel);
    let entries: import('node:fs').Dirent[];
    try {
      entries = await fs.readdir(full, { withFileTypes: true });
    } catch { return; }
    for (const e of entries) {
      const next = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) await walk(next);
      else if (e.isFile()) out.push(next);
    }
  }
  await walk(prefix);
  return out;
}

/** 列出某 path 下的「直接子目錄」名稱（給 list runs by date 用）*/
export async function agentsListChildDirs(parentKey: string): Promise<string[]> {
  if (IS_VERCEL) {
    // Blob 沒有「目錄」概念，從 list prefix 推導子目錄第一層
    const all = await blobListPrefix(parentKey.endsWith('/') ? parentKey : `${parentKey}/`);
    const names = new Set<string>();
    const prefix = parentKey.endsWith('/') ? parentKey : `${parentKey}/`;
    for (const p of all) {
      const after = p.startsWith(prefix) ? p.slice(prefix.length) : p;
      const first = after.split('/')[0];
      if (first) names.add(first);
    }
    return Array.from(names);
  }
  return await fsListSubdirs(parentKey);
}

export async function agentsDelete(key: string): Promise<void> {
  if (IS_VERCEL) await blobDelete(key);
  else {
    try { await fs.unlink(path.join(FS_ROOT, key)); }
    catch { /* swallow */ }
  }
}

/** debug / health check：當前模式 */
export function agentsStorageMode(): 'blob' | 'fs' {
  return IS_VERCEL ? 'blob' : 'fs';
}
