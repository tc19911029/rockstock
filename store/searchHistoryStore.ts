import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export interface SearchHistoryItem {
  symbol: string;
  name: string;
  searchedAt: string;
}

const MAX_HISTORY = 12;

interface SearchHistoryStore {
  items: SearchHistoryItem[];
  /** 記一筆搜尋；同代號去重並移到最前、更新時間 */
  record: (symbol: string, name?: string) => void;
  remove: (symbol: string) => void;
  clear: () => void;
}

export const useSearchHistoryStore = create<SearchHistoryStore>()(
  persist(
    (set) => ({
      items: [],
      record: (symbol, name) => {
        const sym = symbol.trim();
        if (!sym || sym === 'mock') return;
        set(s => {
          // 已是最新一筆 → 不動（避免 polling 刷新時每個 tick 重寫 localStorage）
          if (s.items[0]?.symbol === sym) return s;
          const rest = s.items.filter(i => i.symbol !== sym);
          // 沒帶 name 時沿用舊紀錄的 name，避免覆蓋成空字串
          const prevName = s.items.find(i => i.symbol === sym)?.name;
          return {
            items: [
              { symbol: sym, name: name?.trim() || prevName || '', searchedAt: new Date().toISOString() },
              ...rest,
            ].slice(0, MAX_HISTORY),
          };
        });
      },
      remove: (symbol) => set(s => ({ items: s.items.filter(i => i.symbol !== symbol) })),
      clear: () => set({ items: [] }),
    }),
    { name: 'search-history-v1' }
  )
);
