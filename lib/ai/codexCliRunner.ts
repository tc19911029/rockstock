import { execFile } from 'node:child_process';
import { access, mkdtemp, readFile, rm } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DEFAULT_CODEX_PATH = '/Applications/ChatGPT.app/Contents/Resources/codex';
const DEFAULT_TIMEOUT_MS = 12 * 60 * 1000;
const MAX_OUTPUT_BYTES = 8 * 1024 * 1024;

let codexRunActive = false;

export class CodexBusyError extends Error {
  constructor() {
    super('Codex 正在分析另一個問題，請稍後再試');
    this.name = 'CodexBusyError';
  }
}

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
        const detail = stderr.trim().slice(-4_000);
        console.error('[codex-runner] Codex exec failed:', detail || error.message);
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
}

/**
 * 以本機已登入的 Codex App 認證執行一次唯讀分析，回傳最後一則訊息。
 * 同一時間只允許一個分析，避免重複點擊耗盡本機與帳號資源。
 */
export async function runCodexAnalysis(
  prompt: string,
  options: RunCodexOptions = {},
): Promise<string> {
  if (codexRunActive) throw new CodexBusyError();
  codexRunActive = true;

  const projectRoot = options.projectRoot ?? process.cwd();
  let runDir: string | null = null;

  try {
    runDir = await mkdtemp(path.join(os.tmpdir(), 'rockstock-codex-'));
    const outputFile = path.join(runDir, 'last-message.txt');
    const executable = await resolveCodexExecutable();
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
      options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      options.signal,
    );
    const result = (await readFile(outputFile, 'utf8')).trim();
    if (!result) throw new Error('Codex 沒有回傳分析內容');
    return result;
  } catch (error) {
    if (error instanceof CodexBusyError || error instanceof CodexUnavailableError) throw error;
    if (options.signal?.aborted) throw new Error('Codex 分析已取消');
    const message = error instanceof Error ? error.message : String(error);
    if (/ENOENT|not found/i.test(message)) throw new CodexUnavailableError();
    if (/timed out|ETIMEDOUT|SIGTERM/i.test(message)) {
      throw new Error('Codex 分析逾時，請稍後重試');
    }
    throw new Error('Codex 分析失敗，請確認 Codex App 已登入後重試');
  } finally {
    codexRunActive = false;
    if (runDir) await rm(runDir, { recursive: true, force: true }).catch(() => {});
  }
}
