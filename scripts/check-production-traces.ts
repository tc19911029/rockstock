import { promises as fs } from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const traceDir = path.resolve(root, process.argv[2] ?? process.env.NEXT_TRACE_DIR ?? '.next');
const serverDir = path.join(traceDir, 'server');
const appTraceDir = path.join(serverDir, 'app');
const bannedSourceDirs = new Set([
  'data', 'app', 'components', 'features', 'lib', 'store', 'types', '__tests__',
  'e2e', 'android', 'ios', 'artifacts', 'tmp', 'coverage', 'public',
]);
const bannedScriptExtension = /\.(?:ts|tsx|js|mjs|cjs|sh)$/i;

async function walk(dir: string): Promise<string[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const nested = await Promise.all(entries.map(entry => {
    const fullPath = path.join(dir, entry.name);
    return entry.isDirectory() ? walk(fullPath) : Promise.resolve([fullPath]);
  }));
  return nested.flat();
}

async function readTrace(tracePath: string): Promise<string[]> {
  const parsed = JSON.parse(await fs.readFile(tracePath, 'utf8')) as { files?: unknown };
  if (!Array.isArray(parsed.files) || !parsed.files.every(file => typeof file === 'string')) {
    throw new Error(`Invalid NFT trace: ${path.relative(root, tracePath)}`);
  }
  return parsed.files;
}

function rootRelative(tracePath: string, file: string): string | null {
  const resolved = path.resolve(path.dirname(tracePath), file);
  const relative = path.relative(root, resolved);
  return relative.startsWith('..') || path.isAbsolute(relative) ? null : relative;
}

function isBannedRouteSource(relative: string): boolean {
  const [top] = relative.split(path.sep);
  if (bannedSourceDirs.has(top)) return true;
  return top === 'scripts' && bannedScriptExtension.test(relative);
}

async function main(): Promise<void> {
  const instrumentationTrace = path.join(serverDir, 'instrumentation.js.nft.json');
  const instrumentationFiles = await readTrace(instrumentationTrace);
  const tracedData = instrumentationFiles
    .map(file => rootRelative(instrumentationTrace, file))
    .filter((file): file is string => file?.split(path.sep)[0] === 'data');
  if (tracedData.length > 0) {
    throw new Error(`Instrumentation trace captured ${tracedData.length} runtime data files (first: ${tracedData[0]})`);
  }

  const routeTraces = (await walk(appTraceDir)).filter(file => file.endsWith('.nft.json'));
  const violations: string[] = [];
  for (const tracePath of routeTraces) {
    const files = await readTrace(tracePath);
    const banned = files
      .map(file => rootRelative(tracePath, file))
      .filter((file): file is string => file != null && isBannedRouteSource(file));
    if (banned.length > 0) {
      violations.push(`${path.relative(root, tracePath)}: ${banned.length}（首筆 ${banned[0]}）`);
    }
  }
  if (violations.length > 0) {
    throw new Error(`API production traces captured excluded source/runtime trees:\n${violations.join('\n')}`);
  }

  console.log(`Production trace check passed: instrumentation=${instrumentationFiles.length}, routes=${routeTraces.length}`);
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
