/**
 * Contract test：全站排序統一 guardrail（2026-06-15）
 *
 * 背景：排序選項本來散在 15+ 個面板各寫一份，「買進後賺賠」那組（隔開/1日/5日/10日/
 * 20日/最高/最低）被複製 6+ 次、id/label/方向都不一致。已統一到：
 *   - lib/sorting/registry.ts（中央清單，label/方向/缺值的單一事實）
 *   - lib/sorting/sortEngine.ts（applySort：缺值墊底 + 升降序 + 穩定，全站一份）
 *   - components/shared/SortControl.tsx（共用排序 pills）
 *
 * 這個測試守三件事：
 *   1. registry 自洽（key===id、family 合法、方向合法）。
 *   2. sortEngine 行為（缺值永遠墊底、穩定排序、字串 localeCompare）。
 *   3. 防再度重複：前瞻報酬的排序 label 只能存在於 registry，不可又被硬寫進面板。
 */

import fs from 'node:fs';
import path from 'node:path';
import { SORT_OPTIONS, FAMILY_LABEL, sortOption, isSortId } from '@/lib/sorting/registry';
import { applySort } from '@/lib/sorting/sortEngine';

describe('排序中央清單自洽', () => {
  test('每個選項 key === def.id', () => {
    for (const [k, def] of Object.entries(SORT_OPTIONS)) expect(def.id).toBe(k);
  });

  test('family 都在 FAMILY_LABEL 內', () => {
    for (const def of Object.values(SORT_OPTIONS)) {
      expect(FAMILY_LABEL[def.family]).toBeTruthy();
    }
  });

  test('defaultDir 只能是 asc/desc', () => {
    for (const def of Object.values(SORT_OPTIONS)) {
      expect(['asc', 'desc']).toContain(def.defaultDir);
    }
  });

  test('每個選項都有非空 label', () => {
    for (const def of Object.values(SORT_OPTIONS)) expect(def.label.length).toBeGreaterThan(0);
  });

  test('sortOption 未知 id 會拋錯、isSortId 正確', () => {
    expect(() => sortOption('does.not.exist')).toThrow();
    expect(isSortId('fwd.d5')).toBe(true);
    expect(isSortId('does.not.exist')).toBe(false);
  });

  test('反指標決議保留：陸股應買預設低分在前（asc）', () => {
    expect(sortOption('score.cnBuy').defaultDir).toBe('asc');
  });
});

describe('共用排序引擎行為', () => {
  test('缺值永遠墊底，與升降序無關', () => {
    const items = [{ v: 3 }, { v: null }, { v: 1 }];
    const acc = (it: { v: number | null }) => it.v;
    const desc = applySort(items, 'fwd.d5', 'desc', acc).map((i) => i.v);
    const asc = applySort(items, 'fwd.d5', 'asc', acc).map((i) => i.v);
    expect(desc).toEqual([3, 1, null]); // 缺值墊底
    expect(asc).toEqual([1, 3, null]); // 升序但缺值仍墊底
  });

  test('穩定排序：同值保持原順序', () => {
    const items = [{ id: 'a', v: 1 }, { id: 'b', v: 1 }, { id: 'c', v: 2 }];
    const out = applySort(items, 'mkt.change', 'desc', (it: { id: string; v: number }) => it.v).map((i) => i.id);
    expect(out).toEqual(['c', 'a', 'b']);
  });

  test('字串值走 localeCompare', () => {
    const items = [{ n: 'banana' }, { n: 'apple' }, { n: 'cherry' }];
    const out = applySort(items, 'name', 'asc', (it: { n: string }) => it.n, { missingLast: false }).map((i) => i.n);
    expect(out).toEqual(['apple', 'banana', 'cherry']);
  });

  test('missingLast=false 時數字缺值按 0 排，不產生 NaN comparator', () => {
    const items = [{ id: 'missing', v: undefined }, { id: 'positive', v: 2 }, { id: 'negative', v: -1 }];
    const desc = applySort(items, 'mkt.change', 'desc', (it) => it.v).map((i) => i.id);
    const asc = applySort(items, 'mkt.change', 'asc', (it) => it.v).map((i) => i.id);
    expect(desc).toEqual(['positive', 'missing', 'negative']);
    expect(asc).toEqual(['negative', 'missing', 'positive']);
  });

  test('不就地修改原陣列', () => {
    const items = [{ v: 1 }, { v: 2 }];
    const copy = [...items];
    applySort(items, 'mkt.change', 'desc', (it: { v: number }) => it.v);
    expect(items).toEqual(copy);
  });
});

describe('防再度硬寫排序 label', () => {
  // 「買進後賺賠」那組的完整 label —— 統一後只能出現在 registry，面板一律走 SortControl 取
  const FWD_LABELS = ['漲跌·開盤缺口', '漲跌·1日', '漲跌·5日', '漲跌·10日', '漲跌·20日', '漲跌·最高', '漲跌·最低'];
  const ROOTS = ['components', 'features', 'app'];

  function walk(dir: string, out: string[] = []): string[] {
    if (!fs.existsSync(dir)) return out;
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, ent.name);
      if (ent.isDirectory()) walk(p, out);
      else if (/\.(ts|tsx)$/.test(ent.name)) out.push(p);
    }
    return out;
  }

  test('前瞻報酬排序 label 不可硬寫在面板（必須走中央清單）', () => {
    const files = ROOTS.flatMap((r) => walk(path.join(process.cwd(), r)));
    const offenders: string[] = [];
    for (const file of files) {
      const c = fs.readFileSync(file, 'utf-8');
      for (const lbl of FWD_LABELS) {
        if (c.includes(lbl)) { offenders.push(`${path.relative(process.cwd(), file)} :: ${lbl}`); break; }
      }
    }
    expect(offenders).toEqual([]);
  });
});
