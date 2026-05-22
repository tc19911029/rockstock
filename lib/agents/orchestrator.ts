/**
 * Multi-Agent Orchestrator — state machine + 檔案橋接 helper
 *
 * P1 範圍：只實作 Phase 1（Technical Agent）所需的 IO；其他 phase 留 stub。
 *
 * 檔案結構：
 *   /tmp/rockstock-agents/{date}/{symbol}/
 *     ├─ _phase.json            ← lockfile（currentPhase + 完成狀態）
 *     ├─ technical-question.json
 *     └─ technical-answer.json  ← 由 /multi-agent-decide skill 寫
 *
 *   完成後 persist 到：
 *   data/agents/runs/{date}/{symbol}/
 *     ├─ _meta.json
 *     ├─ technical.json
 *     └─ ...
 *
 * 約束：
 *   - 不引 LLM SDK
 *   - 寫檔走 atomicFsPut（避免並行覆寫 interleave）
 *   - 路徑不可逃逸（pathSafety 檢查）
 */

import path from 'node:path';
import { promises as fs } from 'node:fs';
import { atomicFsPut } from '@/lib/storage/atomicFsPut';
import {
  AGENT_SCHEMA_VERSION,
  AgentId,
  AgentPhaseState,
  AgentRunMeta,
  BearThesis,
  BullThesis,
  ChipAnswer,
  ChipQuestion,
  DebateQuestion,
  DecisionQuestion,
  FinalDecision,
  FundamentalAnswer,
  FundamentalQuestion,
  NewsAnswer,
  NewsQuestion,
  RiskAnswer,
  RiskQuestion,
  TechnicalAnswer,
  TechnicalQuestion,
} from '@/lib/agents/types';
import type { MarketId } from '@/lib/scanner/types';

// ────────────────────────────────────────────────────────────────────────────
// 路徑 helper
// ────────────────────────────────────────────────────────────────────────────

const TMP_ROOT = '/tmp/rockstock-agents';

export interface AgentRunPaths {
  /** ephemeral question / answer 區（skill 讀寫）*/
  tmpDir: string;
  /** 持久化區（contract / UI 讀）*/
  persistDir: string;
}

export function getRunPaths(date: string, symbol: string): AgentRunPaths {
  ensureSafeSegment(date);
  ensureSafeSegment(symbol);
  return {
    tmpDir: path.join(TMP_ROOT, date, symbol),
    persistDir: path.join(process.cwd(), 'data', 'agents', 'runs', date, symbol),
  };
}

function ensureSafeSegment(seg: string): void {
  if (!/^[A-Za-z0-9._-]+$/.test(seg)) {
    throw new Error(`[agents/orchestrator] unsafe path segment: ${seg}`);
  }
}

async function ensureDir(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
}

// ────────────────────────────────────────────────────────────────────────────
// runId 產生
// ────────────────────────────────────────────────────────────────────────────

export function makeRunId(date: string, symbol: string, scanTime?: string): string {
  const ts = scanTime
    ? new Date(scanTime).toISOString().replace(/[-:.]/g, '').slice(0, 14)
    : new Date().toISOString().replace(/[-:.]/g, '').slice(0, 14);
  return `${date}-${symbol}-${ts}`;
}

// ────────────────────────────────────────────────────────────────────────────
// Phase lockfile（_phase.json）
// ────────────────────────────────────────────────────────────────────────────

/**
 * Phase state 持久化策略（2026-05-22 修）
 *
 * 同時寫 /tmp（skill 讀取用，效能優先）+ data/agents/runs/（永久落地）。
 * 讀取時優先 /tmp（最新進行中），fallback data/（避免 /tmp 被歸檔後狀態遺失）。
 */
export async function writePhaseState(
  date: string, symbol: string, state: AgentPhaseState,
): Promise<void> {
  const { tmpDir, persistDir } = getRunPaths(date, symbol);
  const data = JSON.stringify(state, null, 2);
  await ensureDir(tmpDir);
  await ensureDir(persistDir);
  await Promise.all([
    atomicFsPut(path.join(tmpDir, '_phase.json'), data),
    atomicFsPut(path.join(persistDir, '_phase.json'), data),
  ]);
}

export async function readPhaseState(
  date: string, symbol: string,
): Promise<AgentPhaseState | null> {
  const { tmpDir, persistDir } = getRunPaths(date, symbol);
  // 優先讀 /tmp（最新進行中的 state）
  for (const dir of [tmpDir, persistDir]) {
    try {
      const raw = await fs.readFile(path.join(dir, '_phase.json'), 'utf-8');
      return JSON.parse(raw) as AgentPhaseState;
    } catch {
      /* try next */
    }
  }
  return null;
}

export function makeInitialPhaseState(args: {
  runId: string;
  date: string;
  symbol: string;
  market: MarketId;
}): AgentPhaseState {
  return {
    schemaVersion: AGENT_SCHEMA_VERSION,
    runId: args.runId,
    date: args.date,
    symbol: args.symbol,
    market: args.market,
    startedAt: new Date().toISOString(),
    currentPhase: 1,
    completed: {},
  };
}

// ────────────────────────────────────────────────────────────────────────────
// Question / Answer IO（per agent）
// ────────────────────────────────────────────────────────────────────────────

/** 寫 question.json 到 tmp 區（給 skill 讀）*/
export async function writeQuestion(
  date: string, symbol: string, agent: AgentId, question: unknown,
): Promise<string> {
  const { tmpDir } = getRunPaths(date, symbol);
  await ensureDir(tmpDir);
  const file = path.join(tmpDir, `${agent}-question.json`);
  await atomicFsPut(file, JSON.stringify(question, null, 2));
  return file;
}

/** 讀 answer.json（驗證前用）*/
export async function readAnswer<T>(
  date: string, symbol: string, agent: AgentId,
): Promise<T | null> {
  const { tmpDir, persistDir } = getRunPaths(date, symbol);
  // 先看 persist 區（已完成），再看 tmp（進行中）
  for (const dir of [persistDir, tmpDir]) {
    try {
      const candidate = path.join(dir, dir === persistDir ? `${agent}.json` : `${agent}-answer.json`);
      const raw = await fs.readFile(candidate, 'utf-8');
      return JSON.parse(raw) as T;
    } catch {
      /* try next */
    }
  }
  return null;
}

// ────────────────────────────────────────────────────────────────────────────
// Technical Agent — Phase 1 specialised helpers
// ────────────────────────────────────────────────────────────────────────────

export async function writeTechnicalQuestion(
  question: TechnicalQuestion,
): Promise<string> {
  return writeQuestion(question.date, question.symbol, 'technical', question);
}

export async function readTechnicalAnswer(
  date: string, symbol: string,
): Promise<TechnicalAnswer | null> {
  return readAnswer<TechnicalAnswer>(date, symbol, 'technical');
}

// ── P3：News / Chip / Fundamental Agent ──────────────────────────────────────

export async function writeNewsQuestion(question: NewsQuestion): Promise<string> {
  return writeQuestion(question.date, question.symbol, 'news', question);
}
export async function readNewsAnswer(date: string, symbol: string): Promise<NewsAnswer | null> {
  return readAnswer<NewsAnswer>(date, symbol, 'news');
}

export async function writeChipQuestion(question: ChipQuestion): Promise<string> {
  return writeQuestion(question.date, question.symbol, 'chip', question);
}
export async function readChipAnswer(date: string, symbol: string): Promise<ChipAnswer | null> {
  return readAnswer<ChipAnswer>(date, symbol, 'chip');
}

export async function writeFundamentalQuestion(question: FundamentalQuestion): Promise<string> {
  return writeQuestion(question.date, question.symbol, 'fundamental', question);
}
export async function readFundamentalAnswer(date: string, symbol: string): Promise<FundamentalAnswer | null> {
  return readAnswer<FundamentalAnswer>(date, symbol, 'fundamental');
}

// ── P4：Risk / Bull / Bear / Decision ────────────────────────────────────────

export async function writeRiskQuestion(question: RiskQuestion): Promise<string> {
  return writeQuestion(question.date, question.symbol, 'risk', question);
}
export async function readRiskAnswer(date: string, symbol: string): Promise<RiskAnswer | null> {
  return readAnswer<RiskAnswer>(date, symbol, 'risk');
}

export async function writeBullQuestion(question: DebateQuestion): Promise<string> {
  return writeQuestion(question.date, question.symbol, 'bull', question);
}
export async function readBullThesis(date: string, symbol: string): Promise<BullThesis | null> {
  return readAnswer<BullThesis>(date, symbol, 'bull');
}

export async function writeBearQuestion(question: DebateQuestion): Promise<string> {
  return writeQuestion(question.date, question.symbol, 'bear', question);
}
export async function readBearThesis(date: string, symbol: string): Promise<BearThesis | null> {
  return readAnswer<BearThesis>(date, symbol, 'bear');
}

export async function writeDecisionQuestion(question: DecisionQuestion): Promise<string> {
  return writeQuestion(question.date, question.symbol, 'decision', question);
}
export async function readFinalDecision(date: string, symbol: string): Promise<FinalDecision | null> {
  return readAnswer<FinalDecision>(date, symbol, 'decision');
}

// ────────────────────────────────────────────────────────────────────────────
// Persist：完成後從 /tmp 移到 data/agents/runs/
// ────────────────────────────────────────────────────────────────────────────

/**
 * 把單一 agent 的 answer 從 tmp 區複製到持久化區，並更新 phase state
 *
 * 不刪 tmp 檔（讓 skill 後續 phase 還能讀）— 整個 run 完成才清 tmp（由 cleanupRun 處理）
 */
export async function persistAgentAnswer(args: {
  date: string;
  symbol: string;
  agent: AgentId;
}): Promise<{ persistedAt: string; persistedPath: string }> {
  const { date, symbol, agent } = args;
  const { tmpDir, persistDir } = getRunPaths(date, symbol);
  await ensureDir(persistDir);

  const src = path.join(tmpDir, `${agent}-answer.json`);
  const dst = path.join(persistDir, `${agent}.json`);
  const raw = await fs.readFile(src, 'utf-8');
  await atomicFsPut(dst, raw);

  const persistedAt = new Date().toISOString();

  // 更新 phase state
  const phase = await readPhaseState(date, symbol);
  if (phase) {
    phase.completed[agent] = { at: persistedAt, answerPath: dst };
    // P1：completed 後 phase → 'completed'（之後 P2+ 改成 next phase 編號）
    if (agent === 'technical') phase.currentPhase = 'completed';
    await writePhaseState(date, symbol, phase);
  }

  return { persistedAt, persistedPath: dst };
}

/** Run 完成後寫 _meta.json，並（可選）清 tmp */
export async function writeRunMeta(meta: AgentRunMeta): Promise<string> {
  const { persistDir } = getRunPaths(meta.date, meta.symbol);
  await ensureDir(persistDir);
  const file = path.join(persistDir, '_meta.json');
  await atomicFsPut(file, JSON.stringify(meta, null, 2));
  return file;
}

/** 清理 tmp 區（整個 symbol 目錄）— 整個 run 完成後可呼叫 */
export async function cleanupRunTmp(date: string, symbol: string): Promise<void> {
  const { tmpDir } = getRunPaths(date, symbol);
  await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => { /* ignore */ });
}

/**
 * 歸檔整個 run（同步搬 /tmp + data/agents/runs/ 到 archive）
 *
 * 用於：使用者想暫時隱藏某檔 run（如試跑後想清舊資料）但不想真的刪。
 * archive 路徑：/tmp/rockstock-agents-archive/{date}/{symbol}/ + data/agents/runs-archive/{date}/{symbol}/
 */
export async function archiveRun(date: string, symbol: string): Promise<{
  archivedTmp: boolean;
  archivedData: boolean;
  tmpArchivePath: string;
  dataArchivePath: string;
}> {
  ensureSafeSegment(date);
  ensureSafeSegment(symbol);

  const { tmpDir, persistDir } = getRunPaths(date, symbol);
  const tmpArchive = path.join('/tmp/rockstock-agents-archive', date, symbol);
  const dataArchive = path.join(
    process.cwd(),
    'data', 'agents', 'runs-archive', date, symbol,
  );

  let archivedTmp = false;
  let archivedData = false;

  // 搬 /tmp（用 rename 較快）
  try {
    await fs.access(tmpDir);
    await fs.mkdir(path.dirname(tmpArchive), { recursive: true });
    await fs.rm(tmpArchive, { recursive: true, force: true });
    await fs.rename(tmpDir, tmpArchive);
    archivedTmp = true;
  } catch {
    /* tmp 不存在或沒權限 — 不算 fatal */
  }

  // 搬 data/agents/runs/
  try {
    await fs.access(persistDir);
    await fs.mkdir(path.dirname(dataArchive), { recursive: true });
    await fs.rm(dataArchive, { recursive: true, force: true });
    await fs.rename(persistDir, dataArchive);
    archivedData = true;
  } catch {
    /* data/ 不存在 — 不算 fatal */
  }

  return { archivedTmp, archivedData, tmpArchivePath: tmpArchive, dataArchivePath: dataArchive };
}

/** 還原已歸檔的 run（從 archive 搬回原位）*/
export async function restoreRun(date: string, symbol: string): Promise<{
  restoredTmp: boolean;
  restoredData: boolean;
}> {
  ensureSafeSegment(date);
  ensureSafeSegment(symbol);

  const { tmpDir, persistDir } = getRunPaths(date, symbol);
  const tmpArchive = path.join('/tmp/rockstock-agents-archive', date, symbol);
  const dataArchive = path.join(
    process.cwd(),
    'data', 'agents', 'runs-archive', date, symbol,
  );

  let restoredTmp = false;
  let restoredData = false;

  try {
    await fs.access(tmpArchive);
    await fs.mkdir(path.dirname(tmpDir), { recursive: true });
    await fs.rm(tmpDir, { recursive: true, force: true });
    await fs.rename(tmpArchive, tmpDir);
    restoredTmp = true;
  } catch { /* ignore */ }

  try {
    await fs.access(dataArchive);
    await fs.mkdir(path.dirname(persistDir), { recursive: true });
    await fs.rm(persistDir, { recursive: true, force: true });
    await fs.rename(dataArchive, persistDir);
    restoredData = true;
  } catch { /* ignore */ }

  return { restoredTmp, restoredData };
}
