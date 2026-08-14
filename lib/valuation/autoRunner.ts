import { accessSync, closeSync, constants, openSync } from 'node:fs';
import { promises as fs } from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { validateValuationOutput } from './outputValidation';

const JOB_DIR = '/tmp/rockstock-valuation/jobs';
const RUNTIME_DIR = '/tmp/rockstock-valuation/runtime';
const DEFAULT_CODEX_BINS = [
  // Codex is bundled in the current ChatGPT desktop app. Keep the legacy
  // Codex.app path as a fallback for machines that have not migrated yet.
  '/Applications/ChatGPT.app/Contents/Resources/codex',
  '/Applications/Codex.app/Contents/Resources/codex',
  '/opt/homebrew/bin/codex',
  '/usr/local/bin/codex',
] as const;
const RUNNING_TTL_MS = 20 * 60 * 1000;

export interface ValuationJobResult {
  ok: boolean;
  status: 'started' | 'already_running' | 'completed' | 'failed';
  detail: string;
  pid?: number;
  logPath?: string;
}

export type ValuationAnalysisMode = 'incremental' | 'deep';

interface JobStatus {
  symbol: string;
  date: string;
  status: 'running' | 'completed' | 'failed';
  pid?: number;
  startedAt: string;
  finishedAt?: string;
  exitCode?: number | null;
  outputPath: string;
  logPath: string;
  stagedOutputPath?: string;
  error?: string;
  mode?: ValuationAnalysisMode;
  expectedDataAsOf?: MutableRecord;
}

type MutableRecord = Record<string, unknown>;

function isMutableRecord(value: unknown): value is MutableRecord {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}

function normalizeEpsBasis(value: unknown): 'reported' | 'latest_shares' | 'fully_diluted' | 'normalized' | null {
  const text = String(value ?? '').toLowerCase();
  if (text === 'reported' || text.includes('報表')) return 'reported';
  if (text === 'fully_diluted' || text.includes('fully diluted') || text.includes('完全稀釋')) return 'fully_diluted';
  if (text === 'latest_shares' || text.includes('最新股數')) return 'latest_shares';
  if (text === 'normalized' || text.includes('normaliz') || text.includes('正常化')) return 'normalized';
  return null;
}

/**
 * Agent 可用百分比或較具描述性的欄位名稱輸出；發布前只做可逆、確定性的格式正規化，
 * 不替它補估值假設或改動 EPS／PE／合理價。
 */
export function normalizeValuationOutput(
  value: unknown,
  publishedAt = new Date(),
  expectedDataAsOf?: MutableRecord,
): unknown {
  if (!isMutableRecord(value)) return value;
  const source = value;
  const normalized: MutableRecord = { ...source, generatedAt: publishedAt.toISOString() };
  const scenarioKeys = ['pessimistic', 'base', 'optimistic'] as const;

  if (isMutableRecord(source.monthlyEpsEstimate) && !Number.isFinite(source.monthlyEpsEstimate.estimatedEps)) {
    normalized.monthlyEpsEstimate = null;
  }

  // 資料指紋由 Rockstar 的結構化輸入決定，不能讓 Agent 自由改寫；否則同一份資料會被
  // 誤判成新公告，造成不必要的完整重跑。
  if (expectedDataAsOf) normalized.dataAsOf = expectedDataAsOf;

  if (isMutableRecord(source.scenarios)) {
    const normalizedScenarios: MutableRecord = { ...source.scenarios };
    for (const key of scenarioKeys) {
      const scenario = source.scenarios[key];
      if (!isMutableRecord(scenario)) continue;
      const basis = normalizeEpsBasis(scenario.valuationEpsBasis);
      const probability = scenario.probability;
      normalizedScenarios[key] = {
        ...scenario,
        ...(typeof probability === 'number' && Number.isFinite(probability) && probability > 1 && probability <= 100
          ? { probability: probability / 100 }
          : {}),
        ...(basis
          ? {
              valuationEpsBasis: basis,
              ...(scenario.valuationEpsBasis !== basis ? { valuationEpsBasisNote: String(scenario.valuationEpsBasis) } : {}),
            }
          : {}),
      };
    }
    normalized.scenarios = normalizedScenarios;
  }

  const dilution = source.dilution;
  if (isMutableRecord(dilution)) {
    const scenarios = isMutableRecord(normalized.scenarios) ? normalized.scenarios : null;
    const originalShares = dilution.originalShares ?? dilution.prePlacementShares;
    const newShares = dilution.newShares ?? dilution.fullyDilutedSharesUsed;
    const ratio = dilution.ratio ?? dilution.dilutionRateVsPrePlacement;
    if (
      typeof originalShares === 'number' && Number.isFinite(originalShares)
      && typeof newShares === 'number' && Number.isFinite(newShares)
      && typeof ratio === 'number' && Number.isFinite(ratio)
      && scenarios
    ) {
      const pessimistic = isMutableRecord(scenarios.pessimistic) ? scenarios.pessimistic : null;
      const base = isMutableRecord(scenarios.base) ? scenarios.base : null;
      const optimistic = isMutableRecord(scenarios.optimistic) ? scenarios.optimistic : null;
      normalized.dilution = {
        ...dilution,
        originalShares,
        newShares,
        ratio,
        pessimisticDilutedEps: dilution.pessimisticDilutedEps ?? pessimistic?.valuationEps,
        baseDilutedEps: dilution.baseDilutedEps ?? base?.valuationEps,
        optimisticDilutedEps: dilution.optimisticDilutedEps ?? optimistic?.valuationEps,
        pessimisticDilutedPrice: dilution.pessimisticDilutedPrice ?? pessimistic?.fairPrice,
        baseDilutedPrice: dilution.baseDilutedPrice ?? base?.fairPrice,
        optimisticDilutedPrice: dilution.optimisticDilutedPrice ?? optimistic?.fairPrice,
      };
    }
  }

  const valuationMethod = source.valuationMethod;
  if (isMutableRecord(valuationMethod)) {
    const primary = isMutableRecord(valuationMethod.primary) ? valuationMethod.primary : null;
    const crossValidation = isMutableRecord(valuationMethod.crossValidation)
      ? valuationMethod.crossValidation
      : isMutableRecord(valuationMethod.crossCheck)
        ? valuationMethod.crossCheck
        : null;
    normalized.valuationMethod = {
      ...valuationMethod,
      ...(valuationMethod.primaryModel == null && (typeof primary?.method === 'string' || typeof primary?.name === 'string')
        ? { primaryModel: primary.method ?? primary.name }
        : {}),
      ...(!Array.isArray(valuationMethod.crossChecks) && crossValidation
        ? { crossChecks: [crossValidation] }
        : {}),
    };
  }

  return normalized;
}

export function buildValuationCodexArgs(options: {
  workDir: string;
  questionPath: string;
  symbol: string;
  date: string;
  outputPath: string;
  mode?: ValuationAnalysisMode;
}): string[] {
  const refreshInstruction = options.mode === 'incremental'
    ? '這是增量估值：question.json 內含 previousValuation 與 refreshPlan。保留未變的同業選擇、來源證據與估值模型，只查核 refreshPlan 指出的新公告並重算受影響情境；不得把未變資料整份重新搜尋。'
    : '這是完整深度估值，需依技能逐項查核所有必要資料。';
  const prompt = [
    `使用 source-command-valuation skill 分析 ${options.symbol}（資料日 ${options.date}）的單股估值。`,
    `只讀取 ${options.questionPath}，完整執行技能要求，且只能把最終 JSON 寫入 ${options.outputPath}。`,
    '完成前必須驗證最新股數、公司行動、正式財報口徑、同業 PE 與所有情境算術；不要呼叫 Anthropic API。',
    'generatedAt 必須是寫檔當下的 ISO 時間且不得使用未來時間；scenario.probability 必須用 0–1；valuationEpsBasis 只能是 reported、latest_shares、fully_diluted、normalized。',
    '若 dilution 不為 null，必須包含 originalShares、newShares、ratio，以及三情境 dilutedEps 與 dilutedPrice 相容欄位。',
    refreshInstruction,
    '這是隔離的唯讀分析工作：嚴禁修改其他檔案、修改程式碼、執行 git commit／push、部署、啟動服務或委派子代理；寫完指定 JSON 後立即結束。',
  ].join(' ');

  return [
    'exec',
    '--ephemeral',
    '--sandbox',
    'workspace-write',
    '--skip-git-repo-check',
    '-C',
    options.workDir,
    prompt,
  ];
}

interface CodexBinaryEnv {
  ROCKSTOCK_CODEX_BIN?: string;
  CODEX_BIN?: string;
  PATH?: string;
}

interface ResolveCodexBinaryOptions {
  env?: CodexBinaryEnv;
  fallbackCandidates?: readonly string[];
}

function isExecutableFile(candidate: string): boolean {
  try {
    accessSync(candidate, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export function resolveCodexBinary(options: ResolveCodexBinaryOptions = {}): string | null {
  const env = options.env ?? process.env;
  const pathCandidates = (env.PATH ?? '')
    .split(path.delimiter)
    .filter(Boolean)
    .map(directory => path.join(directory, 'codex'));
  const candidates = [
    env.ROCKSTOCK_CODEX_BIN,
    env.CODEX_BIN,
    ...pathCandidates,
    ...(options.fallbackCandidates ?? DEFAULT_CODEX_BINS),
  ].filter((item): item is string => Boolean(item));

  return [...new Set(candidates)].find(isExecutableFile) ?? null;
}

function isProcessAlive(pid: number | undefined): boolean {
  if (!pid || !Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function readJobStatus(statusPath: string): Promise<JobStatus | null> {
  try {
    return JSON.parse(await fs.readFile(statusPath, 'utf-8')) as JobStatus;
  } catch {
    return null;
  }
}

async function writeJobStatus(statusPath: string, status: JobStatus): Promise<void> {
  await fs.writeFile(statusPath, JSON.stringify(status, null, 2), 'utf-8');
}

async function publishStagedValuation(options: {
  stagedOutputPath: string;
  finalOutputPath: string;
  symbol: string;
  date: string;
  pid?: number;
  expectedDataAsOf?: MutableRecord;
}): Promise<void> {
  const raw = await fs.readFile(options.stagedOutputPath, 'utf-8');
  const valuation = normalizeValuationOutput(
    JSON.parse(raw),
    new Date(),
    options.expectedDataAsOf,
  ) as Record<string, unknown>;
  if (valuation.symbol !== options.symbol || valuation.date !== options.date) {
    throw new Error('估值輸出的股票代號或資料日期不符');
  }

  const quality = validateValuationOutput(valuation);
  if (!quality.valid) {
    throw new Error(`估值輸出驗證失敗：${quality.errors.map(issue => issue.message).join('；')}`);
  }

  await fs.mkdir(path.dirname(options.finalOutputPath), { recursive: true });
  const tempOutputPath = `${options.finalOutputPath}.${options.pid ?? 'job'}.tmp`;
  await fs.writeFile(tempOutputPath, `${JSON.stringify(valuation, null, 2)}\n`, 'utf-8');
  await fs.rename(tempOutputPath, options.finalOutputPath);
}

async function findRecoverableOutput(jobBase: string, preferred?: string): Promise<string[]> {
  const candidates: Array<{ filePath: string; mtimeMs: number }> = [];
  if (preferred) {
    const stat = await fs.stat(preferred).catch(() => null);
    if (stat?.isFile()) candidates.push({ filePath: preferred, mtimeMs: stat.mtimeMs });
  }
  const entries = await fs.readdir(RUNTIME_DIR, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith(`${jobBase}-`)) continue;
    const filePath = path.join(RUNTIME_DIR, entry.name, 'valuation.json');
    if (filePath === preferred) continue;
    const stat = await fs.stat(filePath).catch(() => null);
    if (stat?.isFile()) candidates.push({ filePath, mtimeMs: stat.mtimeMs });
  }
  return candidates.sort((a, b) => b.mtimeMs - a.mtimeMs).map(item => item.filePath);
}

async function finalizeValuationJob(options: {
  statusPath: string;
  runningStatus: JobStatus;
  exitCode: number | null;
  stagedOutputPath: string;
  finalOutputPath: string;
}): Promise<void> {
  const { statusPath, runningStatus, exitCode, stagedOutputPath, finalOutputPath } = options;
  try {
    if (exitCode !== 0) throw new Error(`內建分析引擎結束碼 ${exitCode ?? 'signal'}`);

    await publishStagedValuation({
      stagedOutputPath,
      finalOutputPath,
      symbol: runningStatus.symbol,
      date: runningStatus.date,
      pid: runningStatus.pid,
      expectedDataAsOf: runningStatus.expectedDataAsOf,
    });
    await writeJobStatus(statusPath, {
      ...runningStatus,
      status: 'completed',
      finishedAt: new Date().toISOString(),
      exitCode,
      stagedOutputPath,
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    await fs.appendFile(runningStatus.logPath, `\n[rockstar] ${detail}\n`, 'utf-8').catch(() => undefined);
    await writeJobStatus(statusPath, {
      ...runningStatus,
      status: 'failed',
      finishedAt: new Date().toISOString(),
      exitCode,
      error: detail,
    });
  }
}

export async function startValuationAnalysis(options: {
  symbol: string;
  date: string;
  questionPath: string;
  outputPath: string;
  repoRoot?: string;
  force?: boolean;
  mode?: ValuationAnalysisMode;
}): Promise<ValuationJobResult> {
  const { symbol, date } = options;
  if (!/^\d{4,6}$/.test(symbol) || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return { ok: false, status: 'failed', detail: '股票代號或日期格式不合法' };
  }

  const repoRoot = options.repoRoot ?? process.cwd();
  const expectedOutputPath = path.join(repoRoot, 'data', 'valuation', date, `${symbol}.json`);
  const finalOutputPath = path.resolve(repoRoot, options.outputPath);
  if (finalOutputPath !== expectedOutputPath) {
    return { ok: false, status: 'failed', detail: '估值輸出路徑不合法' };
  }

  await fs.mkdir(JOB_DIR, { recursive: true });
  await fs.mkdir(RUNTIME_DIR, { recursive: true });
  const jobBase = `${symbol}-${date}`;
  const statusPath = path.join(JOB_DIR, `${jobBase}.status.json`);
  const logPath = path.join(JOB_DIR, `${jobBase}.log`);

  const previous = await readJobStatus(statusPath);
  const previousAge = previous ? Date.now() - Date.parse(previous.startedAt) : Number.POSITIVE_INFINITY;
  if (previous?.status === 'running' && previousAge < RUNNING_TTL_MS && isProcessAlive(previous.pid)) {
    return {
      ok: true,
      status: 'already_running',
      detail: '內建深度估值已在背景執行',
      pid: previous.pid,
      logPath: previous.logPath,
    };
  }

  if (!options.force && previous?.status === 'completed') {
    const raw = await fs.readFile(finalOutputPath, 'utf-8').catch(() => null);
    if (raw) {
      const quality = validateValuationOutput(JSON.parse(raw));
      if (quality.valid) {
        return {
          ok: true,
          status: 'completed',
          detail: '深度估值已完成並可直接載入',
          pid: previous.pid,
          logPath,
        };
      }
    }
  }

  // 舊工作已有 staged JSON、但曾被舊版格式閘門拒絕或程序中斷時，先重新嚴格驗證；
  // 只有通過目前契約才安全恢復，避免把已完成的昂貴查核整份重跑。
  if (previous?.status === 'failed' || (previous?.status === 'running' && !isProcessAlive(previous.pid))) {
    const recoverable = await findRecoverableOutput(jobBase, previous.stagedOutputPath);
    for (const stagedOutputPath of recoverable) {
      try {
        await publishStagedValuation({ stagedOutputPath, finalOutputPath, symbol, date, pid: previous.pid });
        await writeJobStatus(statusPath, {
          ...previous,
          status: 'completed',
          finishedAt: new Date().toISOString(),
          outputPath: finalOutputPath,
          stagedOutputPath,
          error: undefined,
        });
        return {
          ok: true,
          status: 'completed',
          detail: '已驗證並發布完成的背景估值',
          pid: previous.pid,
          logPath,
        };
      } catch {
        // 仍不符合目前契約就正常重跑，不繞過驗證。
      }
    }
  }

  const codexBin = resolveCodexBinary();
  if (!codexBin) {
    return { ok: false, status: 'failed', detail: '找不到 Rockstar 內建分析引擎（Codex CLI）' };
  }

  // 估值 Agent 在隔離暫存目錄工作；完成且通過 schema／算術驗證後，才由主程序原子發布。
  const workDir = await fs.mkdtemp(path.join(RUNTIME_DIR, `${jobBase}-`));
  const isolatedQuestionPath = path.join(workDir, 'question.json');
  const stagedOutputPath = path.join(workDir, 'valuation.json');
  const question = JSON.parse(await fs.readFile(options.questionPath, 'utf-8')) as Record<string, unknown>;
  const expectedDataAsOf = isMutableRecord(question.expectedDataAsOf)
    ? question.expectedDataAsOf
    : undefined;
  await fs.writeFile(isolatedQuestionPath, JSON.stringify({ ...question, outputPath: stagedOutputPath }, null, 2), 'utf-8');

  const logFd = openSync(logPath, 'a');
  const args = buildValuationCodexArgs({
    workDir,
    questionPath: isolatedQuestionPath,
    symbol,
    date,
    outputPath: stagedOutputPath,
    mode: options.mode,
  });
  const startedAt = new Date().toISOString();

  try {
    const child = spawn(codexBin, args, {
      cwd: workDir,
      detached: true,
      stdio: ['ignore', logFd, logFd],
      env: { ...process.env },
    });

    await new Promise<void>((resolve, reject) => {
      child.once('spawn', resolve);
      child.once('error', reject);
    });

    const runningStatus: JobStatus = {
      symbol,
      date,
      status: 'running',
      pid: child.pid,
      startedAt,
      outputPath: finalOutputPath,
      logPath,
      stagedOutputPath,
      mode: options.mode,
      expectedDataAsOf,
    };
    await writeJobStatus(statusPath, runningStatus);

    child.once('exit', (exitCode) => {
      void finalizeValuationJob({
        statusPath,
        runningStatus,
        exitCode,
        stagedOutputPath,
        finalOutputPath,
      }).catch(() => undefined);
    });
    child.unref();

    return {
      ok: true,
      status: 'started',
      detail: 'Rockstar 內建深度估值已在背景啟動',
      pid: child.pid,
      logPath,
    };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    await writeJobStatus(statusPath, {
      symbol,
      date,
      status: 'failed',
      startedAt,
      finishedAt: new Date().toISOString(),
      outputPath: finalOutputPath,
      logPath,
      stagedOutputPath,
    }).catch(() => undefined);
    return { ok: false, status: 'failed', detail, logPath };
  } finally {
    closeSync(logFd);
  }
}

export async function getValuationAnalysisStatus(options: { symbol: string; date: string }): Promise<{
  status: 'running' | 'completed' | 'failed';
  startedAt: string;
  finishedAt?: string;
  error?: string;
  mode?: ValuationAnalysisMode;
} | null> {
  if (!/^\d{4,6}$/.test(options.symbol) || !/^\d{4}-\d{2}-\d{2}$/.test(options.date)) return null;
  const statusPath = path.join(JOB_DIR, `${options.symbol}-${options.date}.status.json`);
  const status = await readJobStatus(statusPath);
  if (!status) return null;
  if (status.status === 'running' && !isProcessAlive(status.pid)) {
    return {
      status: 'failed',
      startedAt: status.startedAt,
      finishedAt: status.finishedAt,
      error: '背景分析程序已停止，請重新執行',
      mode: status.mode,
    };
  }
  return {
    status: status.status,
    startedAt: status.startedAt,
    finishedAt: status.finishedAt,
    error: status.error,
    mode: status.mode,
  };
}
