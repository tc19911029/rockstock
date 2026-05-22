/**
 * Memory storage — 純 markdown 檔案
 *
 * 路徑：data/agents/memory/{kind}.md
 *      data/agents/memory/weekly/{ISO-week}.md
 *
 * 這個 storage **不被** 任何 prepare/skill 讀取 — 只給 GET API 供 UI 顯示。
 * 確保 memory 不會回寫到 agent 邏輯（§0 紅線）。
 */

import path from 'node:path';
import { promises as fs } from 'node:fs';
import { atomicFsPut } from '@/lib/storage/atomicFsPut';
import { MEMORY_KINDS, MemoryFileMeta, MemoryKind } from './types';

const MEMORY_DIR = path.join(process.cwd(), 'data', 'agents', 'memory');

export function getMemoryPath(kind: MemoryKind, weekKey?: string): string {
  if (kind === 'weekly') {
    if (!weekKey || !/^\d{4}-W\d{2}$/.test(weekKey)) {
      throw new Error(`weekly kind needs valid ISO week key (e.g. 2026-W21), got: ${weekKey}`);
    }
    return path.join(MEMORY_DIR, 'weekly', `${weekKey}.md`);
  }
  return path.join(MEMORY_DIR, `${kind}.md`);
}

export async function readMemory(kind: MemoryKind, weekKey?: string): Promise<string | null> {
  try {
    return await fs.readFile(getMemoryPath(kind, weekKey), 'utf-8');
  } catch {
    return null;
  }
}

export async function writeMemory(
  kind: MemoryKind,
  content: string,
  weekKey?: string,
): Promise<string> {
  const file = getMemoryPath(kind, weekKey);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await atomicFsPut(file, content);
  return file;
}

export async function listMemoryFiles(): Promise<MemoryFileMeta[]> {
  const metas: MemoryFileMeta[] = [];

  for (const kind of MEMORY_KINDS) {
    if (kind === 'weekly') continue;  // weekly 另外處理
    const filePath = getMemoryPath(kind);
    metas.push(await getMeta(kind, filePath));
  }

  // weekly 列出所有歷史檔
  const weeklyDir = path.join(MEMORY_DIR, 'weekly');
  try {
    const files = await fs.readdir(weeklyDir);
    for (const f of files.sort().reverse()) {
      const m = f.match(/^(\d{4}-W\d{2})\.md$/);
      if (!m) continue;
      metas.push(await getMeta('weekly', path.join(weeklyDir, f), m[1]));
    }
  } catch {
    /* no weekly dir yet */
  }

  return metas;
}

async function getMeta(kind: MemoryKind, filePath: string, weekKey?: string): Promise<MemoryFileMeta> {
  try {
    const stat = await fs.stat(filePath);
    const content = await fs.readFile(filePath, 'utf-8');
    const firstLine = content.split('\n').find(l => l.trim().length > 0) ?? '';
    return {
      kind,
      path: filePath + (weekKey ? `?week=${weekKey}` : ''),
      exists: true,
      updatedAt: stat.mtime.toISOString(),
      sizeBytes: stat.size,
      title: firstLine.replace(/^#+\s*/, '').slice(0, 80) || null,
    };
  } catch {
    return {
      kind,
      path: filePath,
      exists: false,
      updatedAt: null,
      sizeBytes: 0,
      title: null,
    };
  }
}
