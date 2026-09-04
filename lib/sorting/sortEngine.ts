/**
 * 共用排序函式 — 全站一份（2026-06-15）
 *
 * 取代散在各面板的 6+ 份「dir 乘數 + 缺值排最後 + switch」複製邏輯。
 * 各面板只需提供 accessor（id → 該列可比較值），其餘交給這裡。
 *
 * 規則：
 *  - 可比較值為 number 時數值比較；string 時 localeCompare（中文/代號）。
 *  - null / undefined / NaN 視為「缺值」。missingLast=true 時缺值永遠墊底（不受升降序影響）；
 *    false 時缺值當 0/空字串參與排序（沿用舊面板對盤面欄位的行為）。
 *  - 穩定排序：值相等時保持原順序（用原索引當尾鍵）。
 */

import { sortOption, type SortDir } from './registry';

export type SortValue = number | string | null | undefined;

/** 該列在某個排序 id 下的可比較值。各面板自行實作（列型別不同）。 */
export type SortAccessor<T> = (item: T, id: string) => SortValue;

function isMissing(v: SortValue): boolean {
  return v == null || (typeof v === 'number' && Number.isNaN(v));
}

/**
 * 比較兩個可比較值（不含方向、不含缺值墊底）。
 * 回傳 >0 代表 a 應排在 b 之後（升序語意）。
 */
function compareValues(a: SortValue, b: SortValue): number {
  if (typeof a === 'string' || typeof b === 'string') {
    return String(a ?? '').localeCompare(String(b ?? ''));
  }
  // missingLast=false 的盤面欄位允許缺值參與排序；數字缺值一律正規化成 0，
  // 避免 undefined - number 產生 NaN，令 V8 comparator 悄悄失效。
  const av = typeof a === 'number' && Number.isFinite(a) ? a : 0;
  const bv = typeof b === 'number' && Number.isFinite(b) ? b : 0;
  return av - bv;
}

export interface ApplySortOptions {
  /** 缺值是否永遠墊底（預設依該排序 id 的 registry 設定） */
  missingLast?: boolean;
}

/**
 * 依某個排序 id 對陣列排序，回傳新陣列（不就地修改）。
 *
 * @param items   要排序的列
 * @param id      排序 id（registry 已註冊）
 * @param dir     方向
 * @param access  accessor：id → 可比較值
 */
export function applySort<T>(
  items: readonly T[],
  id: string,
  dir: SortDir,
  access: SortAccessor<T>,
  options?: ApplySortOptions,
): T[] {
  const missingLast = options?.missingLast ?? sortOption(id).missingLast;
  const mult = dir === 'desc' ? -1 : 1;

  // 預先取值 + 帶原索引，確保穩定排序
  const decorated = items.map((item, index) => ({ item, index, value: access(item, id) }));

  decorated.sort((a, b) => {
    const aMissing = isMissing(a.value);
    const bMissing = isMissing(b.value);
    if (missingLast && (aMissing || bMissing)) {
      if (aMissing && bMissing) return a.index - b.index; // 都缺 → 保持原序
      return aMissing ? 1 : -1; // 缺值墊底，與方向無關
    }
    const cmp = compareValues(a.value, b.value);
    if (cmp !== 0) return mult * cmp;
    return a.index - b.index; // 穩定
  });

  return decorated.map((d) => d.item);
}

/**
 * 產生一個可直接丟給 Array.prototype.sort 的 comparator（少數需要 in-place 或與其他
 * comparator 串接的場景用）。語意同 applySort。
 */
export function sortComparator<T>(
  id: string,
  dir: SortDir,
  access: SortAccessor<T>,
  options?: ApplySortOptions,
): (a: T, b: T) => number {
  const missingLast = options?.missingLast ?? sortOption(id).missingLast;
  const mult = dir === 'desc' ? -1 : 1;
  return (a, b) => {
    const va = access(a, id);
    const vb = access(b, id);
    const aMissing = isMissing(va);
    const bMissing = isMissing(vb);
    if (missingLast && (aMissing || bMissing)) {
      if (aMissing && bMissing) return 0;
      return aMissing ? 1 : -1;
    }
    return mult * compareValues(va, vb);
  };
}
