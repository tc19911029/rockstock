/**
 * Contract test：頁面版面一致性 guardrail（B4）
 *
 * 守「新分頁不可又跑版」：
 *   - 每個 app/**\/page.tsx（非 redirect stub、非已知待修 allowlist）
 *     必須用 <PageShell>（統一外框 + header nav），
 *     且不可寫死 bg-slate/zinc/gray-NNN（會破壞主題切換，原 /sectors 的病根）。
 *
 * allowlist = 目前已知還沒套統一版面的舊頁（ratchet：修一個就從清單移除一個）。
 * 新頁若沒套 PageShell 或寫死底色 → 測試紅，逼開發時就套好。
 */

import fs from 'node:fs';
import path from 'node:path';

const APP_DIR = path.join(process.cwd(), 'app');

// redirect stub（client 轉跳到首頁 tab，URL 僅 bookmark 相容）— 不需 PageShell
const REDIRECT_STUBS = new Set([
  'today/page.tsx',
  'youtube/page.tsx',
  'youtube/replay/page.tsx',
  'youtube/trends/page.tsx',
  'agents/page.tsx',
  'agents/pool/page.tsx',
  'etf/page.tsx',     // → 首頁右側「ETF 追蹤」tab（2026-06-21）
]);

// 非產品頁（設計系統示範）— 故意展示各種 class，完全排除
const EXCLUDE = new Set([
  'mockup/page.tsx',
]);

// 已知待修舊頁（debt）— 修好後從這裡移除（移除後測試會自動開始守它）
const ALLOWLIST = new Set([
  'diagnose/[market]/[symbol]/[date]/page.tsx',
  'disclaimer/page.tsx',
]);

function findPages(dir: string, base = ''): string[] {
  const out: string[] = [];
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const rel = base ? `${base}/${ent.name}` : ent.name;
    if (ent.isDirectory()) out.push(...findPages(path.join(dir, ent.name), rel));
    else if (ent.name === 'page.tsx') out.push(rel);
  }
  return out;
}

const isStub = (content: string) =>
  /redirect\(|router\.(replace|push)/.test(content) && !content.includes('PageShell');

describe('頁面版面一致性 guardrail', () => {
  const pages = findPages(APP_DIR);

  test('找得到頁面（sanity）', () => {
    expect(pages.length).toBeGreaterThan(10);
  });

  test('每個實頁都用 PageShell（redirect stub / allowlist 除外）', () => {
    const offenders: string[] = [];
    for (const rel of pages) {
      if (REDIRECT_STUBS.has(rel) || ALLOWLIST.has(rel) || EXCLUDE.has(rel)) continue;
      const content = fs.readFileSync(path.join(APP_DIR, rel), 'utf-8');
      if (isStub(content)) continue;
      if (!content.includes('PageShell')) offenders.push(rel);
    }
    expect(offenders).toEqual([]);
  });

  test('實頁不可寫死 bg-slate/zinc/gray-NNN（破壞主題）', () => {
    const offenders: string[] = [];
    for (const rel of pages) {
      if (REDIRECT_STUBS.has(rel) || ALLOWLIST.has(rel) || EXCLUDE.has(rel)) continue;
      const content = fs.readFileSync(path.join(APP_DIR, rel), 'utf-8');
      if (isStub(content)) continue;
      if (/\bbg-(slate|zinc|gray)-\d{2,3}\b/.test(content)) offenders.push(rel);
    }
    expect(offenders).toEqual([]);
  });

  test('allowlist 不可膨脹（debt 只能減不能增）', () => {
    // 目前允許 2 個待修舊頁；新增頁不可塞進 allowlist 規避
    expect(ALLOWLIST.size).toBeLessThanOrEqual(2);
  });
});
