import { execFile } from 'node:child_process';
import { access, mkdtemp, readFile, rm } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  codexScheduler,
  type CodexQueueProgress,
} from '@/lib/ai/codexConcurrency';

const DEFAULT_CODEX_PATH = '/Applications/ChatGPT.app/Contents/Resources/codex';
export const DEFAULT_CODEX_TIMEOUT_MS = 20 * 60 * 1000;
const MAX_OUTPUT_BYTES = 8 * 1024 * 1024;

export class CodexUnavailableError extends Error {
  constructor(message = '找不到 Codex CLI，請先開啟 Codex App 並確認已登入') {
    super(message);
    this.name = 'CodexUnavailableError';
  }
}

interface CodexExecArgsInput {
  projectRoot: string;
  prompt: string;
  outputFile: string;
  outputSchema?: string;
  imagePaths?: string[];
}

/** 純函式，讓 CLI 權限與參數可由單元測試鎖住。 */
export function buildCodexExecArgs(input: CodexExecArgsInput): string[] {
  const args = [
    'exec',
    '--ephemeral',
    '--sandbox',
    'read-only',
    '-C',
    input.projectRoot,
  ];
  // `--image <FILE>...` 是 variadic；後面必須再放一個 option 終止，否則會吞掉 prompt。
  for (const imagePath of input.imagePaths ?? []) args.push('--image', imagePath);
  args.push('-o', input.outputFile);
  if (input.outputSchema) args.push('--output-schema', input.outputSchema);
  args.push(input.prompt);
  return args;
}

function codexChildEnv(): NodeJS.ProcessEnv {
  // 不把 Next.js 服務內的券商、Anthropic、MiniMax 等金鑰傳給子程序。
  // Codex 使用使用者已登入的本機 Codex/ChatGPT 認證。
  const allow = [
    'HOME', 'PATH', 'TMPDIR', 'USER', 'LOGNAME', 'SHELL', 'LANG', 'LC_ALL',
    'CODEX_HOME', 'XDG_CONFIG_HOME',
  ];
  const env: NodeJS.ProcessEnv = {
    NO_COLOR: '1',
    NODE_ENV: process.env.NODE_ENV ?? 'development',
  };
  for (const key of allow) {
    const value = process.env[key];
    if (value) env[key] = value;
  }
  return env;
}

async function resolveCodexExecutable(): Promise<string> {
  const candidates = [process.env.ROCKSTOCK_CODEX_CLI_PATH, DEFAULT_CODEX_PATH, 'codex']
    .filter((value): value is string => !!value);

  for (const candidate of candidates) {
    if (candidate === 'codex') return candidate;
    try {
      await access(candidate, fsConstants.X_OK);
      return candidate;
    } catch {
      // 繼續找下一個候選路徑。
    }
  }
  throw new CodexUnavailableError();
}

function runExecFile(
  executable: string,
  args: string[],
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = execFile(executable, args, {
      cwd: args[args.indexOf('-C') + 1],
      env: codexChildEnv(),
      timeout: timeoutMs,
      maxBuffer: MAX_OUTPUT_BYTES,
      encoding: 'utf8',
      signal,
    }, (error, stdout, stderr) => {
      if (error) {
        const execError = error as NodeJS.ErrnoException & {
          killed?: boolean;
          signal?: NodeJS.Signals | null;
        };
        const detail = stderr.trim().slice(-4_000);
        console.error('[codex-runner] Codex exec failed:', {
          code: execError.code,
          signal: execError.signal,
          killed: execError.killed,
          detail: detail || error.message,
        });
        reject(error);
        return;
      }
      resolve({ stdout, stderr });
    });
    // `codex exec` 在非 TTY 下會讀 stdin 作為補充 context；立刻送 EOF，避免長請求卡住。
    child.stdin?.end();
  });
}

export interface RunCodexOptions {
  projectRoot?: string;
  outputSchema?: string;
  imagePaths?: string[];
  timeoutMs?: number;
  signal?: AbortSignal;
  onProgress?: (progress: CodexQueueProgress) => void;
}

interface CodexProcessError extends NodeJS.ErrnoException {
  killed?: boolean;
  signal?: NodeJS.Signals | null;
  cause?: unknown;
}

function errorCode(error: unknown): string | number | undefined {
  if (!error || typeof error !== 'object') return undefined;
  return (error as { code?: string | number }).code;
}

/**
 * 只用 child_process 的結構化欄位判定 CLI 是否真的無法啟動。
 * Codex 的 stderr 會包含網路搜尋、工具錯誤與分析原文；不能因文字裡出現
 * `not found` 或 `ENOENT` 就把一個已經執行數分鐘的分析誤報成 CLI 不存在。
 */
export function normalizeCodexExecutionError(
  error: unknown,
  aborted = false,
): Error {
  if (error instanceof CodexUnavailableError) return error;
  if (aborted) return new Error('Codex 分析已取消');

  const processError = error && typeof error === 'object'
    ? error as CodexProcessError
    : null;
  const code = errorCode(processError);
  const causeCode = errorCode(processError?.cause);

  if (code === 'ENOENT' || causeCode === 'ENOENT') {
    return new CodexUnavailableError();
  }
  if (
    processError?.killed === true
    || processError?.signal === 'SIGTERM'
    || code === 'ETIMEDOUT'
  ) {
    return new Error('Codex 分析逾時，請稍後重試');
  }
  return new Error('Codex 分析失敗，請稍後重試');
}

/**
 * 以本機已登入的 Codex App 認證執行一次唯讀分析，回傳最後一則訊息。
 * 全系統最多同時執行三個分析；超出的工作依 FIFO 排隊。
 */
export async function runCodexAnalysis(
  prompt: string,
  options: RunCodexOptions = {},
): Promise<string> {
  const projectRoot = options.projectRoot ?? process.cwd();
  let runDir: string | null = null;
  let releaseSlot: (() => void) | null = null;

  try {
    const executable = await resolveCodexExecutable();
    releaseSlot = await codexScheduler.acquire({
      signal: options.signal,
      onProgress: options.onProgress,
    });
    runDir = await mkdtemp(path.join(os.tmpdir(), 'rockstock-codex-'));
    const outputFile = path.join(runDir, 'last-message.txt');
    const args = buildCodexExecArgs({
      projectRoot,
      prompt,
      outputFile,
      outputSchema: options.outputSchema,
      imagePaths: options.imagePaths,
    });
    await runExecFile(
      executable,
      args,
      options.timeoutMs ?? DEFAULT_CODEX_TIMEOUT_MS,
      options.signal,
    );
    const result = (await readFile(outputFile, 'utf8')).trim();
    if (!result) throw new Error('Codex 沒有回傳分析內容');
    return result;
  } catch (error) {
    throw normalizeCodexExecutionError(error, options.signal?.aborted);
  } finally {
    releaseSlot?.();
    if (runDir) await rm(runDir, { recursive: true, force: true }).catch(() => {});
  }
}
