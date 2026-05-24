/**
 * Trade Journal — 已平倉交易的 narrative 註記 overlay
 *
 * 為什麼是 overlay：
 *   - trades.json 設計為 append-only（封存後不可變，類比 Layer 1）
 *   - 但 user 平倉後幾天，事後 review / lessons 是會補的
 *   - 解法：annotations 走獨立 `trade-journal.json`，按 tradeId join，
 *     trades.json 本身不動
 *
 * Schema：
 *   data/agents/portfolio/trade-journal.json
 *   {
 *     schemaVersion: 1,
 *     entries: { [tradeId]: JournalEntry },
 *     updatedAt: string
 *   }
 */

import path from 'node:path';
import { promises as fs } from 'node:fs';
import { atomicFsPut } from '@/lib/storage/atomicFsPut';

export const JOURNAL_SCHEMA_VERSION = 1 as const;

export interface JournalEntry {
  schemaVersion: typeof JOURNAL_SCHEMA_VERSION;
  tradeId: string;
  /** 為什麼這筆要進場（book rule / signal / 多源共識 / 直覺）*/
  entryReason?: string;
  /** 當下用的出場規則（如「守紅K低」「MA5 跌破停利」「持滿 10 日換股」）*/
  exitRule?: string;
  /** 事後 review：對在哪、錯在哪、下次怎麼做 */
  postMortem?: string;
  /** 學到什麼 */
  lessons?: string[];
  /** 1-5 自評：執行 vs 計畫的契合度 */
  executionScore?: number;
  updatedAt: string;
}

export interface JournalFile {
  schemaVersion: typeof JOURNAL_SCHEMA_VERSION;
  entries: Record<string, JournalEntry>;
  updatedAt: string;
}

const JOURNAL_DIR = path.join(process.cwd(), 'data', 'agents', 'portfolio');
const JOURNAL_FILE = path.join(JOURNAL_DIR, 'trade-journal.json');

export async function loadJournal(): Promise<JournalFile> {
  try {
    const raw = await fs.readFile(JOURNAL_FILE, 'utf-8');
    return JSON.parse(raw) as JournalFile;
  } catch {
    return {
      schemaVersion: JOURNAL_SCHEMA_VERSION,
      entries: {},
      updatedAt: new Date().toISOString(),
    };
  }
}

async function saveJournal(file: JournalFile): Promise<void> {
  await fs.mkdir(JOURNAL_DIR, { recursive: true });
  file.updatedAt = new Date().toISOString();
  await atomicFsPut(JOURNAL_FILE, JSON.stringify(file, null, 2));
}

/** Upsert 一筆 journal entry（partial — 只有提供的欄位會更新）*/
export async function upsertJournalEntry(
  tradeId: string,
  patch: Partial<Omit<JournalEntry, 'schemaVersion' | 'tradeId' | 'updatedAt'>>,
): Promise<JournalEntry> {
  const file = await loadJournal();
  const now = new Date().toISOString();
  const existing = file.entries[tradeId];
  const next: JournalEntry = {
    schemaVersion: JOURNAL_SCHEMA_VERSION,
    tradeId,
    ...(existing ?? {}),
    ...patch,
    updatedAt: now,
  };
  file.entries[tradeId] = next;
  await saveJournal(file);
  return next;
}

export async function deleteJournalEntry(tradeId: string): Promise<void> {
  const file = await loadJournal();
  if (file.entries[tradeId]) {
    delete file.entries[tradeId];
    await saveJournal(file);
  }
}
