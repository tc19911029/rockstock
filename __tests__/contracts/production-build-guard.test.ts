import {
  assertProductionBuildOutputIsSafe,
  findRepoListener,
} from '@/lib/deployment/productionBuildGuard';

type CommandRunner = (command: string, args: string[]) => string;

function runnerFor(cwd: string): CommandRunner {
  return (command, args) => {
    if (command !== 'lsof') throw new Error(`unexpected command: ${command}`);
    if (args[0] === '-tiTCP:3000') return '4242\n';
    if (args.includes('-p') && args.includes('4242')) return `p4242\nfcwd\nn${cwd}\n`;
    throw new Error(`unexpected args: ${args.join(' ')}`);
  };
}

describe('production build output guard', () => {
  test('finds a port 3000 listener owned by this repository', () => {
    expect(findRepoListener('/repo', runnerFor('/repo'))).toEqual({
      pid: '4242',
      cwd: '/repo',
    });
  });

  test('ignores a listener owned by another working directory', () => {
    expect(findRepoListener('/repo', runnerFor('/other-app'))).toBeNull();
  });

  test('blocks an in-place production build while the repo server is running', () => {
    expect(() => assertProductionBuildOutputIsSafe({
      isProductionBuild: true,
      distDir: '.next',
      rootDir: '/repo',
      runCommand: runnerFor('/repo'),
    })).toThrow(/已阻擋會覆寫正式服務 \.next/);
  });

  test.each(['.next-deploy', '.next-preview'])('allows isolated output %s', (distDir) => {
    expect(() => assertProductionBuildOutputIsSafe({
      isProductionBuild: true,
      distDir,
      rootDir: '/repo',
      runCommand: runnerFor('/repo'),
    })).not.toThrow();
  });

  test('allows non-production phases', () => {
    expect(() => assertProductionBuildOutputIsSafe({
      isProductionBuild: false,
      distDir: '.next',
      rootDir: '/repo',
      runCommand: runnerFor('/repo'),
    })).not.toThrow();
  });
});
