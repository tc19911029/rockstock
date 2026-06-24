'use client';

/**
 * 鍵盤上下鍵跳股票（2026-06-24）
 *
 * 看「題材分類」成分股清單 / 「掃描結果」/「候選池」時，按 ↑↓ 在清單裡跳上一檔/下一檔並載圖。
 * 左右鍵已被走圖步進占用（前後一根 K 棒），上下鍵剛好留給換股。
 *
 * 做法刻意走 DOM 標記、不另存清單陣列：
 *   - 每個可點的股票元素帶 `data-navstock="<裸碼>"`（StockLink 自動標、掃描走圖鈕/候選池列手動標）。
 *   - 每個清單容器帶 `data-navlist="<id>"`（題材成分股一律 sector-members、掃描 scan-results、候選池 pool）。
 *     題材區同一時間只會展開一個成分股清單，故共用常數 id 即可，不必傳 prop。
 *   - 點任何股票時（capture 階段，避開掃描走圖鈕的 stopPropagation）記住「作用中的清單 id」。
 *   - 按 ↑↓ 時即時查 DOM：在該清單裡用「目前載入的股票」定位，移到相鄰一檔，直接 .click() 觸發它原本的載圖。
 *
 * 好處：重新排序 / 篩選後清單順序變了，導覽自動跟著「畫面上看到的順序」，不會用到過時的陣列。
 */

import { useEffect } from 'react';
import { useReplayStore } from '@/store/replayStore';
import { create } from 'zustand';

/** 把代號正規化成可比對的裸碼：去 .TW/.TWO/.SS/.SZ/.BJ 後綴、去 ^ 指數前綴、大寫。 */
export function navKey(code: string | null | undefined): string {
  if (!code) return '';
  return code.replace(/\.(TW|TWO|SS|SZ|BJ)$/i, '').replace(/^\^/, '').toUpperCase();
}

interface ChartNavState {
  /** 目前由鍵盤上下鍵操控的清單 id（最後一次點到的股票所屬清單）。 */
  activeListId: string | null;
  setActiveList: (id: string | null) => void;
}

export const useChartNavStore = create<ChartNavState>((set) => ({
  activeListId: null,
  setActiveList: (id) => set((s) => (s.activeListId === id ? s : { activeListId: id })),
}));

function cssAttrEscape(v: string): string {
  return v.replace(/["\\]/g, '\\$&');
}

/**
 * ↑↓ 跳股：在作用中的清單裡，相對「目前載入的股票」往前/往後一檔並載圖。
 * @param delta +1 = 下一檔（往下），-1 = 上一檔（往上）
 * @returns 有沒有處理（false → 呼叫端不要 preventDefault，讓上下鍵照常捲動頁面）
 */
export function navigateStockList(delta: number, currentTicker: string | null): boolean {
  if (typeof document === 'undefined') return false;
  const id = useChartNavStore.getState().activeListId;
  if (!id) return false;
  const container = document.querySelector(`[data-navlist="${cssAttrEscape(id)}"]`);
  if (!container) return false; // 清單已不在畫面（切走 tab/收合）→ 還原預設捲動

  // 同一檔可能有多個可點元素（股名 + 走圖鈕），用 key 去重、保留第一個。
  const seen = new Set<string>();
  const els: HTMLElement[] = [];
  container.querySelectorAll<HTMLElement>('[data-navstock]').forEach((n) => {
    const k = n.getAttribute('data-navstock') ?? '';
    if (!k || seen.has(k)) return;
    seen.add(k);
    els.push(n);
  });
  if (els.length === 0) return false;

  const curKey = navKey(currentTicker);
  const idx = els.findIndex((n) => n.getAttribute('data-navstock') === curKey);
  let next: number;
  if (idx === -1) {
    // 目前載入的股票不在這個清單裡 → 往下從第一檔起、往上從最後一檔起
    next = delta > 0 ? 0 : els.length - 1;
  } else {
    next = Math.min(Math.max(idx + delta, 0), els.length - 1);
  }
  const target = els[next];
  if (!target) return false;
  target.click();
  target.scrollIntoView({ block: 'nearest' });
  return true;
}

/**
 * 在首頁掛一次：用 capture 階段監聽點擊，記住「最後點到的股票」屬於哪個清單。
 * 必須 capture（掃描走圖鈕會 e.stopPropagation()，bubble 階段收不到）。
 */
export function useChartListNavCapture(): void {
  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      const target = e.target as HTMLElement | null;
      const stock = target?.closest?.('[data-navstock]');
      if (!stock) return;
      const list = stock.closest('[data-navlist]');
      useChartNavStore.getState().setActiveList(list?.getAttribute('data-navlist') ?? null);
    };
    document.addEventListener('click', onClick, true);
    return () => document.removeEventListener('click', onClick, true);
  }, []);
}

/** 這檔是不是目前走圖載入的股票（清單高亮用）。boolean selector → 只有換股的兩列會重渲染。 */
export function useIsChartCurrent(code: string | null | undefined): boolean {
  return useReplayStore((s) => {
    const cur = navKey(s.currentStock?.ticker);
    const me = navKey(code);
    return !!cur && cur === me;
  });
}
