import { promises as fs } from 'node:fs';
import path from 'node:path';

type Row = { symbol?: string };

function symbolSet(rows: Row[] | undefined): Set<string> {
  return new Set((rows ?? []).map((row) => row.symbol).filter((symbol): symbol is string => Boolean(symbol)));
}

function diff(left: Set<string>, right: Set<string>): string[] {
  return [...left].filter((symbol) => !right.has(symbol));
}

async function compareScans(backupDir: string, currentDir: string) {
  const dates = (await fs.readdir(backupDir)).filter((name) => /^\d{4}-\d{2}-\d{2}\.json$/.test(name)).sort();
  let changedDates = 0;
  let added = 0;
  let removed = 0;
  for (const name of dates) {
    const [before, after] = await Promise.all([
      fs.readFile(path.join(backupDir, name), 'utf8').then(JSON.parse),
      fs.readFile(path.join(currentDir, name), 'utf8').then(JSON.parse),
    ]);
    const additions = diff(symbolSet(after.records), symbolSet(before.records));
    const removals = diff(symbolSet(before.records), symbolSet(after.records));
    if (additions.length || removals.length) changedDates++;
    added += additions.length;
    removed += removals.length;
  }
  return { dates: dates.length, changedDates, addedOccurrences: added, removedOccurrences: removed };
}

async function compareStrategies(backupDir: string, currentDir: string) {
  const dates = (await fs.readdir(backupDir)).filter((name) => /^\d{4}-\d{2}-\d{2}\.json$/.test(name)).sort();
  const byStrategy: Record<string, { dateSets: number; changedDateSets: number; added: number; removed: number }> = {};
  for (const name of dates) {
    const [before, after] = await Promise.all([
      fs.readFile(path.join(backupDir, name), 'utf8').then(JSON.parse),
      fs.readFile(path.join(currentDir, name), 'utf8').then(JSON.parse),
    ]);
    const keys = new Set([...Object.keys(before.strategies ?? {}), ...Object.keys(after.strategies ?? {})]);
    for (const key of keys) {
      const bucket = byStrategy[key] ??= { dateSets: 0, changedDateSets: 0, added: 0, removed: 0 };
      const additions = diff(symbolSet(after.strategies?.[key]), symbolSet(before.strategies?.[key]));
      const removals = diff(symbolSet(before.strategies?.[key]), symbolSet(after.strategies?.[key]));
      bucket.dateSets++;
      bucket.added += additions.length;
      bucket.removed += removals.length;
      if (additions.length || removals.length) bucket.changedDateSets++;
    }
  }
  return { dates: dates.length, byStrategy };
}

async function main() {
  const root = process.cwd();
  const output = path.join(root, 'data/reports/sanse-history-repair-2026-08-04.json');
  const report = {
    generatedAt: new Date().toISOString(),
    TW: {
      scans: await compareScans(path.join(root, 'data/tw-sanse-scan-backup-2026-08-04T07-48-34-284Z'), path.join(root, 'data/tw-sanse-scan')),
      strategies: await compareStrategies(path.join(root, 'data/tw-sanse-strategy-backup-2026-08-04T07-50-00'), path.join(root, 'data/tw-sanse-strategy')),
    },
    CN: {
      scans: await compareScans(path.join(root, 'data/cn-sanse-scan-backup-2026-08-04T07-48-34-283Z'), path.join(root, 'data/cn-sanse-scan')),
      strategies: await compareStrategies(path.join(root, 'data/cn-sanse-strategy-backup-2026-08-04T07-50-00'), path.join(root, 'data/cn-sanse-strategy')),
    },
  };
  await fs.mkdir(path.dirname(output), { recursive: true });
  await fs.writeFile(output, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({ output, ...report }, null, 2));
}

main().catch((error) => { console.error(error); process.exit(1); });
