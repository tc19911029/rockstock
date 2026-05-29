/**
 * 基本面補漲策略 storage（2026-05-27）
 *
 * 雙寫 pattern：本地 fs + Vercel Blob（同 candidates pool / youtube analysis）
 *   data/strategies/fundamental-revaluation/{market}/{date}.json     — Phase 1 結果
 *   data/strategies/fundamental-revaluation/{market}/{date}-deep.json — Phase 2 skill 寫的深度分析
 *
 * /tmp 暫存（不持久化、給 skill 用）：
 *   /tmp/rockstock-fundamental/{date}-question.json
 *   /tmp/rockstock-agents/queue/{date}/{symbol}/decide-question.json
 */

import fs from 'node:fs/promises';
import path from 'node:path';

import type {
  FundamentalRevaluationSession,
  FundamentalRevaluationDeepSession,
  FundamentalRevaluationResult,
} from './types';

const ROOT = process.cwd();

function sessionPath(market: 'TW' | 'CN', date: string): string {
  return path.join(ROOT, 'data', 'strategies', 'fundamental-revaluation', market, `${date}.json`);
}

function deepPath(market: 'TW' | 'CN', date: string): string {
  return path.join(ROOT, 'data', 'strategies', 'fundamental-revaluation', market, `${date}-deep.json`);
}

async function ensureDir(p: string): Promise<void> {
  await fs.mkdir(path.dirname(p), { recursive: true });
}

const IS_VERCEL = !!process.env.VERCEL;

async function blobPutMaybe(blobPath: string, data: string): Promise<void> {
  if (!IS_VERCEL) return;
  try {
    const { blobPutWithRetry } = await import('@/lib/storage/blobRetry');
    await blobPutWithRetry(blobPath, data, { access: 'private', addRandomSuffix: false, allowOverwrite: true });
  } catch (err) {
    console.error('[fundamental-revaluation/storage] blob put failed:', err);
  }
}

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

// ────────────────────────────────────────────────────────────────────────────
// Phase 1：程式端結果
// ────────────────────────────────────────────────────────────────────────────

export async function saveSession(session: FundamentalRevaluationSession): Promise<void> {
  const json = JSON.stringify(session, null, 2);
  const local = sessionPath(session.market, session.date);
  await ensureDir(local);
  await fs.writeFile(local, json, 'utf-8');
  const blobKey = `strategies/fundamental-revaluation/${session.market}/${session.date}.json`;
  await blobPutMaybe(blobKey, json);
}

export async function loadSession(
  market: 'TW' | 'CN',
  date: string,
): Promise<FundamentalRevaluationSession | null> {
  const local = sessionPath(market, date);
  try {
    const raw = await fs.readFile(local, 'utf-8');
    return JSON.parse(raw) as FundamentalRevaluationSession;
  } catch {
    // fallback blob
    const blobKey = `strategies/fundamental-revaluation/${market}/${date}.json`;
    const raw = await blobGetMaybe(blobKey);
    if (!raw) return null;
    try {
      return JSON.parse(raw) as FundamentalRevaluationSession;
    } catch {
      return null;
    }
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Phase 2：skill 寫的深度分析
// ────────────────────────────────────────────────────────────────────────────

export async function saveDeepSession(session: FundamentalRevaluationDeepSession): Promise<void> {
  const json = JSON.stringify(session, null, 2);
  const local = deepPath(session.market, session.date);
  await ensureDir(local);
  await fs.writeFile(local, json, 'utf-8');
  const blobKey = `strategies/fundamental-revaluation/${session.market}/${session.date}-deep.json`;
  await blobPutMaybe(blobKey, json);
}

export async function loadDeepSession(
  market: 'TW' | 'CN',
  date: string,
): Promise<FundamentalRevaluationDeepSession | null> {
  const local = deepPath(market, date);
  try {
    const raw = await fs.readFile(local, 'utf-8');
    return JSON.parse(raw) as FundamentalRevaluationDeepSession;
  } catch {
    const blobKey = `strategies/fundamental-revaluation/${market}/${date}-deep.json`;
    const raw = await blobGetMaybe(blobKey);
    if (!raw) return null;
    try {
      return JSON.parse(raw) as FundamentalRevaluationDeepSession;
    } catch {
      return null;
    }
  }
}

// ────────────────────────────────────────────────────────────────────────────
// /tmp question payload（給 skill 用，不持久化）
// ────────────────────────────────────────────────────────────────────────────

export interface QuestionPayload {
  market: 'TW' | 'CN';
  date: string;
  strategyVersion: string;
  top20: FundamentalRevaluationResult[];
  expectedOutput: 'fundamental-revaluation-deep@1.0.0';
  instruction: string;
}

export async function writeQuestionPayload(payload: QuestionPayload): Promise<string> {
  const dir = path.join('/tmp', 'rockstock-fundamental');
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, `${payload.date}-${payload.market}-question.json`);
  await fs.writeFile(file, JSON.stringify(payload, null, 2), 'utf-8');
  return file;
}

// ────────────────────────────────────────────────────────────────────────────
// 自動為 Top 20 寫 multi-agent-decide queue
// ────────────────────────────────────────────────────────────────────────────

export interface DecideQueueItem {
  symbol: string;
  name: string;
  market: 'TW' | 'CN';
  prioritySource: 'fundamental-revaluation';
  rank: number;
  total: number;
  grade: string;
  baseFairPrice: number | null;
  todayPrice: number;
  bullPoints: string[];
  riskPoints: string[];
}

export async function writeDecideQueue(
  date: string,
  items: DecideQueueItem[],
): Promise<{ dir: string; count: number }> {
  const dir = path.join('/tmp', 'rockstock-agents', 'queue', date);
  await fs.mkdir(dir, { recursive: true });
  for (const it of items) {
    const symbolDir = path.join(dir, it.symbol);
    await fs.mkdir(symbolDir, { recursive: true });
    const file = path.join(symbolDir, 'decide-question.json');
    await fs.writeFile(file, JSON.stringify(it, null, 2), 'utf-8');
  }
  return { dir, count: items.length };
}
