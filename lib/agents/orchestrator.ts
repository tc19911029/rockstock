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
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { atomicFsPut } from '@/lib/storage/atomicFsPut';
import { agentsPut, agentsPutRaw, agentsGet, agentsGetRaw } from '@/lib/agents/persistStorage';
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
import {
  buildAgentScoreBlock,
  assignGrade,
} from '@/lib/agents/scoring';
import type {
  AgentScoreBlock,
  GradeInput,
  ScoredAgentId,
  SignalValue,
} from '@/lib/agents/scoringTypes';

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

/** Blob/FS key 給 persist 區檔案用（agents/runs/{date}/{symbol}/{filename}）*/
function runKey(date: string, symbol: string, filename: string): string {
  return `agents/runs/${date}/${symbol}/${filename}`;
}

// ────────────────────────────────────────────────────────────────────────────
// runId 產生
// ────────────────────────────────────────────────────────────────────────────

export function makeRunId(date: string, symbol: string, scanTime?: string): string {
  const sourceTs = scanTime
    ? new Date(scanTime).toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)
    : 'manual';
  const runTs = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 17);
  // scanTime 是來源版本，不是執行版本；相同掃描重新 prepare 也必須建立新 run。
  return `${date}-${symbol}-${sourceTs}-${runTs}-${randomUUID().slice(0, 8)}`;
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
  const { tmpDir } = getRunPaths(date, symbol);
  const data = JSON.stringify(state, null, 2);
  // /tmp 永遠寫本地 FS（skill 讀取用、per-pod ephemeral OK）
  await ensureDir(tmpDir);
  await atomicFsPut(path.join(tmpDir, '_phase.json'), data);
  // persist 走 dual-storage（Vercel Blob or local FS）
  await agentsPutRaw(runKey(date, symbol, '_phase.json'), data);
}

export async function readPhaseState(
  date: string, symbol: string,
): Promise<AgentPhaseState | null> {
  const { tmpDir } = getRunPaths(date, symbol);
  // 優先讀 /tmp（最新進行中的 state，per-pod ephemeral but newest）
  try {
    const raw = await fs.readFile(path.join(tmpDir, '_phase.json'), 'utf-8');
    return JSON.parse(raw) as AgentPhaseState;
  } catch { /* fallback to persist */ }
  return await agentsGet<AgentPhaseState>(runKey(date, symbol, '_phase.json'));
}

export function makeInitialPhaseState(args: {
  runId: string;
  date: string;
  symbol: string;
  market: MarketId;
  strategyId?: string;
}): AgentPhaseState {
  return {
    schemaVersion: AGENT_SCHEMA_VERSION,
    runId: args.runId,
    date: args.date,
    symbol: args.symbol,
    market: args.market,
    strategyId: args.strategyId,
    startedAt: new Date().toISOString(),
    currentPhase: 1,
    completed: {},
  };
}

export function selectCurrentRunContext(
  meta: AgentRunMeta | null,
  phase: AgentPhaseState | null,
): { runId?: string; strategyId?: string } {
  if (!meta && !phase) return {};
  if (!meta) return { runId: phase!.runId, strategyId: phase!.strategyId };
  if (!phase) return { runId: meta.runId, strategyId: meta.strategyId };
  if (meta.runId === phase.runId) {
    return { runId: meta.runId, strategyId: phase.strategyId ?? meta.strategyId };
  }
  const metaStarted = Date.parse(meta.startedAt);
  const phaseStarted = Date.parse(phase.startedAt);
  const phaseIsNewer = !Number.isFinite(metaStarted)
    || (Number.isFinite(phaseStarted) && phaseStarted >= metaStarted);
  return phaseIsNewer
    ? { runId: phase.runId, strategyId: phase.strategyId }
    : { runId: meta.runId, strategyId: meta.strategyId };
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
export function answerBelongsToRun(answer: unknown, expectedRunId?: string): boolean {
  if (!expectedRunId) return true;
  return !!answer
    && typeof answer === 'object'
    && 'runId' in answer
    && (answer as { runId?: unknown }).runId === expectedRunId;
}

export async function readAnswer<T>(
  date: string, symbol: string, agent: AgentId, expectedRunId?: string,
): Promise<T | null> {
  // 先看 persist 區（已完成，dual-storage），再看 tmp（進行中）
  const persisted = await agentsGet<T>(runKey(date, symbol, `${agent}.json`));
  if (persisted && answerBelongsToRun(persisted, expectedRunId)) return persisted;
  const { tmpDir } = getRunPaths(date, symbol);
  try {
    const raw = await fs.readFile(path.join(tmpDir, `${agent}-answer.json`), 'utf-8');
    const answer = JSON.parse(raw) as T;
    return answerBelongsToRun(answer, expectedRunId) ? answer : null;
  } catch { return null; }
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
  date: string, symbol: string, expectedRunId?: string,
): Promise<TechnicalAnswer | null> {
  return readAnswer<TechnicalAnswer>(date, symbol, 'technical', expectedRunId);
}

// ── P3：News / Chip / Fundamental Agent ──────────────────────────────────────

export async function writeNewsQuestion(question: NewsQuestion): Promise<string> {
  return writeQuestion(question.date, question.symbol, 'news', question);
}
export async function readNewsAnswer(date: string, symbol: string, expectedRunId?: string): Promise<NewsAnswer | null> {
  return readAnswer<NewsAnswer>(date, symbol, 'news', expectedRunId);
}

export async function writeChipQuestion(question: ChipQuestion): Promise<string> {
  return writeQuestion(question.date, question.symbol, 'chip', question);
}
export async function readChipAnswer(date: string, symbol: string, expectedRunId?: string): Promise<ChipAnswer | null> {
  return readAnswer<ChipAnswer>(date, symbol, 'chip', expectedRunId);
}

export async function writeFundamentalQuestion(question: FundamentalQuestion): Promise<string> {
  return writeQuestion(question.date, question.symbol, 'fundamental', question);
}
export async function readFundamentalAnswer(date: string, symbol: string, expectedRunId?: string): Promise<FundamentalAnswer | null> {
  return readAnswer<FundamentalAnswer>(date, symbol, 'fundamental', expectedRunId);
}

/** 讀 fundamental-question.json（tmp 區）— 給 UI 顯示估值分析輸入用 */
export async function readFundamentalQuestion(
  date: string,
  symbol: string,
  expectedRunId?: string,
): Promise<FundamentalQuestion | null> {
  const { tmpDir } = getRunPaths(date, symbol);
  try {
    const raw = await fs.readFile(path.join(tmpDir, 'fundamental-question.json'), 'utf-8');
    const question = JSON.parse(raw) as FundamentalQuestion;
    return answerBelongsToRun(question, expectedRunId) ? question : null;
  } catch { return null; }
}

// ── P4：Risk / Bull / Bear / Decision ────────────────────────────────────────

export async function writeRiskQuestion(question: RiskQuestion): Promise<string> {
  return writeQuestion(question.date, question.symbol, 'risk', question);
}
export async function readRiskAnswer(date: string, symbol: string, expectedRunId?: string): Promise<RiskAnswer | null> {
  return readAnswer<RiskAnswer>(date, symbol, 'risk', expectedRunId);
}

export async function writeBullQuestion(question: DebateQuestion): Promise<string> {
  return writeQuestion(question.date, question.symbol, 'bull', question);
}
export async function readBullThesis(date: string, symbol: string, expectedRunId?: string): Promise<BullThesis | null> {
  return readAnswer<BullThesis>(date, symbol, 'bull', expectedRunId);
}

export async function writeBearQuestion(question: DebateQuestion): Promise<string> {
  return writeQuestion(question.date, question.symbol, 'bear', question);
}
export async function readBearThesis(date: string, symbol: string, expectedRunId?: string): Promise<BearThesis | null> {
  return readAnswer<BearThesis>(date, symbol, 'bear', expectedRunId);
}

export async function writeDecisionQuestion(question: DecisionQuestion): Promise<string> {
  return writeQuestion(question.date, question.symbol, 'decision', question);
}
export async function readFinalDecision(date: string, symbol: string, expectedRunId?: string): Promise<FinalDecision | null> {
  return readAnswer<FinalDecision>(date, symbol, 'decision', expectedRunId);
}

// ────────────────────────────────────────────────────────────────────────────
// Persist：完成後從 /tmp 移到 data/agents/runs/
// ────────────────────────────────────────────────────────────────────────────

/**
 * 把單一 agent 的 answer 從 tmp 區複製到持久化區，並更新 phase state
 *
 * 2026-05-25 v1 評分系統升級：persist 前自動 enrich
 *   - 4 大 analyst（technical/chip/fundamental/news）：若 answer.scoreBlock.signals 存在
 *     → 程式重算 scoreBlock 覆蓋（LLM 不能自定 score / light / confidence）
 *   - Decision：讀 4 個 analyst.scoreBlock + risk.verdict 算 gradeBlock 覆蓋
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

  const src = path.join(tmpDir, `${agent}-answer.json`);
  const rawOriginal = await fs.readFile(src, 'utf-8');
  const phase = await readPhaseState(date, symbol);
  let rawRunId: unknown;
  try {
    rawRunId = (JSON.parse(rawOriginal) as { runId?: unknown }).runId;
  } catch {
    // 讓既有 schema/JSON 驗證流程處理格式錯誤；此處只阻止明確的跨 run 污染。
  }
  if (phase && rawRunId !== phase.runId) {
    throw new Error(`拒絕保存跨 run answer：expected ${phase.runId}, got ${String(rawRunId)}`);
  }
  const enriched = await enrichAnswerForPersist({ date, symbol, agent, raw: rawOriginal });
  const raw = enriched ?? rawOriginal;
  // enriched 才回寫 tmp（給 phase 3/4 讀到 score）
  if (enriched && enriched !== rawOriginal) {
    await atomicFsPut(src, enriched);
  }
  // dual-storage write
  await agentsPutRaw(runKey(date, symbol, `${agent}.json`), raw);
  const dst = path.join(persistDir, `${agent}.json`);  // legacy path for return

  const persistedAt = new Date().toISOString();

  // 更新 phase state
  if (phase) {
    phase.completed[agent] = { at: persistedAt, answerPath: dst };
    // P1：completed 後 phase → 'completed'（之後 P2+ 改成 next phase 編號）
    if (agent === 'technical') phase.currentPhase = 'completed';
    await writePhaseState(date, symbol, phase);
  }

  return { persistedAt, persistedPath: dst };
}

// ────────────────────────────────────────────────────────────────────────────
// 評分 enrich helper（v1 — 2026-05-25）
//
// 設計：LLM 在 answer 內附 scoreBlock.signals 的 raw 數據；persist 前程式重算
//      score / light / confidence 覆蓋寫回。Decision 算 gradeBlock。
//
// 向下相容：LLM 若沒附 scoreBlock.signals → 不 enrich，保留原 answer
// ────────────────────────────────────────────────────────────────────────────

const SCORED_AGENTS: ReadonlyArray<ScoredAgentId> = ['technical', 'chip', 'fundamental', 'news'];

async function enrichAnswerForPersist(args: {
  date: string;
  symbol: string;
  agent: AgentId;
  raw: string;
}): Promise<string | null> {
  const { date, symbol, agent, raw } = args;
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return null;  // raw 不是合法 JSON，保留原樣讓既有錯誤處理接手
  }

  // 4 大 analyst 的評分 enrich
  if ((SCORED_AGENTS as ReadonlyArray<string>).includes(agent)) {
    const scoredAgent = agent as ScoredAgentId;
    const existing = parsed.scoreBlock as { signals?: Record<string, SignalValue> } | undefined;
    if (existing && existing.signals && typeof existing.signals === 'object') {
      const fresh = buildAgentScoreBlock(scoredAgent, existing.signals);
      parsed.scoreBlock = fresh;
      return JSON.stringify(parsed, null, 2);
    }
    return null;  // LLM 沒附 signals — 保留原 answer
  }

  // Decision 的 gradeBlock + scoresByAgent enrich
  if (agent === 'decision') {
    const expectedRunId = typeof parsed.runId === 'string' ? parsed.runId : undefined;
    const [tech, chip, fund, news, risk] = await Promise.all([
      readAnswer<TechnicalAnswer>(date, symbol, 'technical', expectedRunId),
      readAnswer<ChipAnswer>(date, symbol, 'chip', expectedRunId),
      readAnswer<FundamentalAnswer>(date, symbol, 'fundamental', expectedRunId),
      readAnswer<NewsAnswer>(date, symbol, 'news', expectedRunId),
      readAnswer<RiskAnswer>(date, symbol, 'risk', expectedRunId),
    ]);
    const gradeInput: GradeInput = {
      technical: tech?.scoreBlock ?? null,
      chip: chip?.scoreBlock ?? null,
      fundamental: fund?.scoreBlock ?? null,
      news: news?.scoreBlock ?? null,
      riskVerdict: risk?.verdict ?? null,
    };
    // 至少 2 面有 scoreBlock 才算 gradeBlock — 單面分數高被誤判 A 級不合理
    // 0-1 面 → 跳過 enrich(舊資料相容 / 未升級資料)
    const validBlocks = [gradeInput.technical, gradeInput.chip, gradeInput.fundamental, gradeInput.news]
      .filter(Boolean).length;
    if (validBlocks < 2) {
      return null;
    }
    const gradeBlock = assignGrade(gradeInput);
    parsed.gradeBlock = gradeBlock;
    parsed.scoresByAgent = buildScoresByAgent(gradeInput);
    return JSON.stringify(parsed, null, 2);
  }

  return null;
}

function buildScoresByAgent(input: GradeInput): Partial<Record<ScoredAgentId, {
  score: number; light: string; confidence: string;
}>> {
  const out: Partial<Record<ScoredAgentId, { score: number; light: string; confidence: string }>> = {};
  const pairs: Array<[ScoredAgentId, AgentScoreBlock | null]> = [
    ['technical', input.technical],
    ['chip', input.chip],
    ['fundamental', input.fundamental],
    ['news', input.news],
  ];
  for (const [id, block] of pairs) {
    if (block) {
      out[id] = { score: block.score, light: block.light, confidence: block.confidence };
    }
  }
  return out;
}

/** Run 完成後寫 _meta.json，並（可選）清 tmp */
export async function writeRunMeta(meta: AgentRunMeta): Promise<string> {
  const { persistDir } = getRunPaths(meta.date, meta.symbol);
  await agentsPut(runKey(meta.date, meta.symbol, '_meta.json'), meta);
  return path.join(persistDir, '_meta.json');  // legacy return path
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
