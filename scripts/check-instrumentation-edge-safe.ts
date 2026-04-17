#!/usr/bin/env tsx
/**
 * 鐵律 4：Edge-safe 模組邊界檢查
 *
 * instrumentation.ts 會在 Next.js Edge runtime 執行，
 * 其靜態/動態 import 鏈不能出現 fs / path / fs/promises，否則 HMR 後會炸。
 *
 * 例外：instrumentation.ts 本身的動態 import fs/path（只在本地 dev 的 cron 回呼內執行，
 * Edge bundle 會 skip 但警告）可以容忍，但依賴檔案不行。
 *
 * 用法: `npm run check:edge-safe` 或直接 `npx tsx scripts/check-instrumentation-edge-safe.ts`
 * Exit 1 代表違規。
 */
import { promises as fs } from 'fs';
import path from 'path';

const ROOT = path.resolve(__dirname, '..');
const ENTRY = path.join(ROOT, 'instrumentation.ts');
const BANNED = [/from ['"]fs['"]/, /from ['"]fs\/promises['"]/, /from ['"]path['"]/,
                /import\(['"]fs['"]\)/, /import\(['"]fs\/promises['"]\)/, /import\(['"]path['"]\)/];

// import 來源可以是：
//   import X from './foo'        → 相對
//   import X from '@/lib/foo'    → 專案別名（對應到 ROOT）
//   import('@/lib/foo')           → 動態
const IMPORT_RE = /(?:import\s+[^'"]*from\s+|import\s*\(\s*|export\s+[^'"]*from\s+)['"]([^'"]+)['"]/g;

async function resolveImport(spec: string, fromFile: string): Promise<string | null> {
  let base: string;
  if (spec.startsWith('@/')) base = path.join(ROOT, spec.slice(2));
  else if (spec.startsWith('./') || spec.startsWith('../')) base = path.resolve(path.dirname(fromFile), spec);
  else return null; // node_modules，略
  for (const ext of ['.ts', '.tsx', '/index.ts', '/index.tsx', '.js']) {
    const p = base + ext;
    try { await fs.access(p); return p; } catch { /* next */ }
  }
  return null;
}

async function collectDeps(file: string, visited: Set<string>): Promise<void> {
  if (visited.has(file)) return;
  visited.add(file);
  let src: string;
  try { src = await fs.readFile(file, 'utf-8'); } catch { return; }
  const deps: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = IMPORT_RE.exec(src))) deps.push(m[1]);
  for (const spec of deps) {
    const resolved = await resolveImport(spec, file);
    if (resolved) await collectDeps(resolved, visited);
  }
}

function checkFile(file: string, src: string): string[] {
  const violations: string[] = [];
  src.split('\n').forEach((line, i) => {
    for (const re of BANNED) {
      if (re.test(line)) violations.push(`  line ${i + 1}: ${line.trim()}`);
    }
  });
  return violations;
}

async function main() {
  const visited = new Set<string>();
  await collectDeps(ENTRY, visited);

  let totalViolations = 0;
  const offenders: Array<{ file: string; lines: string[] }> = [];

  for (const file of visited) {
    if (file === ENTRY) continue; // 容許 instrumentation.ts 自己 — 它的動態 import fs/path 只在 nodejs runtime 跑
    const src = await fs.readFile(file, 'utf-8');
    const v = checkFile(file, src);
    if (v.length > 0) {
      offenders.push({ file, lines: v });
      totalViolations += v.length;
    }
  }

  const rel = (p: string) => path.relative(ROOT, p);

  if (totalViolations === 0) {
    console.log(`✅ edge-safe OK：instrumentation.ts 依賴鏈（${visited.size} 檔）無 fs/path 違規`);
    process.exit(0);
  }

  console.error(`❌ edge-safe 違規：共 ${offenders.length} 個檔案、${totalViolations} 處 fs/path import\n`);
  for (const o of offenders) {
    console.error(`  ${rel(o.file)}`);
    for (const l of o.lines) console.error(l);
  }
  console.error(`\n修法：改用 fetch 呼叫宣告 runtime='nodejs' 的 API route，或把檔案從 instrumentation 依賴鏈移除。`);
  process.exit(1);
}

main().catch(err => { console.error(err); process.exit(2); });
