import { execFileSync } from 'node:child_process';
import path from 'node:path';

type CommandRunner = (command: string, args: string[]) => string;

type BuildGuardOptions = {
  isProductionBuild: boolean;
  distDir: string;
  rootDir: string;
  runCommand?: CommandRunner;
};

type RepoListener = {
  pid: string;
  cwd: string;
};

const defaultCommandRunner: CommandRunner = (command, args) =>
  execFileSync(command, args, { encoding: 'utf8' });

export function findRepoListener(
  rootDir: string,
  runCommand: CommandRunner = defaultCommandRunner,
): RepoListener | null {
  let rawPids: string;
  try {
    rawPids = runCommand('lsof', ['-tiTCP:3000', '-sTCP:LISTEN']);
  } catch {
    // lsof exits 1 when nothing is listening. On CI it may not be installed;
    // either case means there is no local production process to protect.
    return null;
  }

  const expectedRoot = path.resolve(rootDir);
  const pids = rawPids.split(/\s+/).filter((pid) => /^\d+$/.test(pid));

  for (const pid of pids) {
    try {
      const cwdOutput = runCommand('lsof', ['-a', '-p', pid, '-d', 'cwd', '-Fn']);
      const cwd = cwdOutput
        .split('\n')
        .find((line) => line.startsWith('n'))
        ?.slice(1);
      if (cwd && path.resolve(cwd) === expectedRoot) return { pid, cwd };
    } catch {
      // The process may have exited between the two lsof calls.
    }
  }

  return null;
}

export function assertProductionBuildOutputIsSafe({
  isProductionBuild,
  distDir,
  rootDir,
  runCommand,
}: BuildGuardOptions): void {
  if (!isProductionBuild || distDir !== '.next') return;

  const listener = findRepoListener(rootDir, runCommand);
  if (!listener) return;

  throw new Error(
    [
      '[build-guard] 已阻擋會覆寫正式服務 .next 的 production build。',
      `PID ${listener.pid} 正從 ${listener.cwd} 服務 localhost:3000。`,
      '請改用 sh scripts/deploy-prod-guard.sh，讓 build 在 .next-deploy 旁路完成後再安全切換。',
    ].join('\n'),
  );
}
