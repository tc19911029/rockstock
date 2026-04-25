import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export interface WatchlistItem {
  symbol: string;
  name: string;
  addedAt: string;
  addedPrice?: number;
  note?: string;
  tags?: string[];
}

interface WatchlistStore {
  items: WatchlistItem[];
  add: (symbol: string, name: string, addedPrice?: number, addedAt?: string) => void;
  remove: (symbol: string) => void;
  has: (symbol: string) => boolean;
  updateNote: (symbol: string, note: string) => void;
  updateAddedPrice: (symbol: string, price: number, addedAt?: string) => void;
  addTag: (symbol: string, tag: string) => void;
  removeTag: (symbol: string, tag: string) => void;
}

export const useWatchlistStore = create<WatchlistStore>()(
  persist(
    (set, get) => ({
      items: [],
      add: (symbol, name, addedPrice, addedAt) => {
        if (!get().has(symbol)) {
          set(s => ({
            items: [...s.items, {
              symbol, name,
              addedAt: addedAt ?? new Date().toISOString(),
              ...(addedPrice != null ? { addedPrice } : {}),
            }],
          }));
        }
      },
      remove: (symbol) => set(s => ({ items: s.items.filter(i => i.symbol !== symbol) })),
      has: (symbol) => get().items.some(i => i.symbol === symbol),
      updateNote: (symbol, note) => set(s => ({
        items: s.items.map(i => i.symbol === symbol ? { ...i, note } : i),
      })),
      updateAddedPrice: (symbol, price, addedAt) => set(s => ({
        items: s.items.map(i => i.symbol === symbol
          ? { ...i, addedPrice: price, ...(addedAt ? { addedAt } : {}) }
          : i),
      })),
      addTag: (symbol, tag) => set(s => ({
        items: s.items.map(i => i.symbol === symbol
          ? { ...i, tags: [...new Set([...(i.tags ?? []), tag.trim()])] }
          : i),
      })),
      removeTag: (symbol, tag) => set(s => ({
        items: s.items.map(i => i.symbol === symbol
          ? { ...i, tags: (i.tags ?? []).filter(t => t !== tag) }
          : i),
      })),
    }),
    { name: 'watchlist-v1' }
  )
);
