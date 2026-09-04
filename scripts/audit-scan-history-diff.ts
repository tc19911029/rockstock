import { promises as fs } from 'node:fs';
import path from 'node:path';

interface ScanSession {
  market?: string;
  direction?: string;
  results?: Array<{ symbol?: string }>;
}

interface Bucket {
  files: number;
  changedFiles: number;
  added: number;
  removed: number;
}

const backupDir = path.resolve(process.argv[2] ?? '');
const outputPath = path.resolve(
  process.argv[3] ?? path.join('data', 'reports', `scan-history-repair-${new Date().toISOString().slice(0, 10)}.json`),
);
const filePattern = /^scan-(TW|CN)-(long|short)-([A-Z]+|daily|mtf)-(\d{4}-\d{2}-\d{2})\.json$/;

function symbols(session: ScanSession): Set<string> {
  return new Set((session.results ?? []).map((row) => row.symbol).filter((symbol): symbol is string => Boolean(symbol)));
}

function difference(left: Set<string>, right: Set<string>): string[] {
  return [...left].filter((symbol) => !right.has(symbol)).sort();
}

async function main() {
  if (!process.argv[2]) throw new Error('用法：npx tsx scripts/audit-scan-history-diff.ts <backup-dir> [output.json]');
  const names = (await fs.readdir(backupDir)).filter((name) => filePattern.test(name)).sort();
  const buckets: Record<string, Bucket> = {};
  const changed: Array<{ file: string; added: string[]; removed: string[] }> = [];
  const missingCurrent: string[] = [];
  const uniqueAdded = new Set<string>();
  const uniqueRemoved = new Set<string>();

  for (const name of names) {
    const match = filePattern.exec(name)!;
    const currentPath = path.join(process.cwd(), 'data', name);
    try {
      await fs.access(currentPath);
    } catch {
      missingCurrent.push(name);
      continue;
    }
    const [before, after] = await Promise.all([
      fs.readFile(path.join(backupDir, name), 'utf8').then((raw) => JSON.parse(raw) as ScanSession),
      fs.readFile(currentPath, 'utf8').then((raw) => JSON.parse(raw) as ScanSession),
    ]);
    const beforeSymbols = symbols(before);
    const afterSymbols = symbols(after);
    const added = difference(afterSymbols, beforeSymbols);
    const removed = difference(beforeSymbols, afterSymbols);
    const key = `${match[1]}/${match[2]}/${match[3]}`;
    const bucket = buckets[key] ??= { files: 0, changedFiles: 0, added: 0, removed: 0 };
    bucket.files++;
    bucket.added += added.length;
    bucket.removed += removed.length;
    if (added.length || removed.length) {
      bucket.changedFiles++;
      changed.push({ file: name, added, removed });
      added.forEach((symbol) => uniqueAdded.add(symbol));
      removed.forEach((symbol) => uniqueRemoved.add(symbol));
    }
  }

  const report = {
    generatedAt: new Date().toISOString(),
    backupDir,
    comparedFiles: names.length - missingCurrent.length,
    changedFiles: changed.length,
    unchangedFiles: names.length - missingCurrent.length - changed.length,
    missingCurrent,
    addedOccurrences: changed.reduce((sum, item) => sum + item.added.length, 0),
    removedOccurrences: changed.reduce((sum, item) => sum + item.removed.length, 0),
    uniqueAddedSymbols: [...uniqueAdded].sort(),
    uniqueRemovedSymbols: [...uniqueRemoved].sort(),
    byTrack: Object.fromEntries(Object.entries(buckets).sort(([a], [b]) => a.localeCompare(b))),
    changed,
  };
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({ outputPath, ...report, changed: undefined }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
