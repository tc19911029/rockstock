import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { isPlaceholderStockName, UNRESOLVED_STOCK_NAME } from '@/lib/stocks/stockIdentity';

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
          const rest = s.items.filter(i => i.symbol !== sym);
          const prevName = s.items.find(i => i.symbol === sym)?.name;
          // 正式名稱可以修復舊的空白／代號紀錄；占位輸入不得洗掉既有正式名稱。
          const nextName = !isPlaceholderStockName(name, sym)
            ? name!.trim()
            : !isPlaceholderStockName(prevName, sym)
              ? prevName!
              : UNRESOLVED_STOCK_NAME;
          // 已是最新且名稱也相同 → 不動，避免 polling 每個 tick 重寫 localStorage。
          if (s.items[0]?.symbol === sym && s.items[0].name === nextName) return s;
          return {
            items: [
              { symbol: sym, name: nextName, searchedAt: new Date().toISOString() },
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
