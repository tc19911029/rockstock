import { create } from 'zustand';
import { persist } from 'zustand/middleware';

/**
 * 多人持倉「檔案」(profile) 的 client 端狀態。
 *
 * - `activeProfileId`：目前查看 / 管理哪一組持倉（persist 到 localStorage，重整後記得）。
 * - `profiles`：從 server `/api/portfolio/profiles` 同步來的清單，供切換器顯示。
 *
 * 刻意**不** import portfolioStore（避免循環依賴）：切換 profile 後的「清空 + 重新 hydrate」
 * 由 UI 層（StoreSync 訂閱 activeProfileId）負責觸發。本 store 只管狀態 + profile 管理 API。
 */

export interface PortfolioProfile {
  id: string;
  name: string;
  createdAt: string;
}

const DEFAULT_PROFILE: PortfolioProfile = { id: 'me', name: '我的', createdAt: '' };

interface ProfileStore {
  activeProfileId: string;
  profiles: PortfolioProfile[];
  /** 切換目前 profile（不重 hydrate，由 StoreSync 訂閱觸發）*/
  setActiveProfile: (id: string) => void;
  /** 從 server 拉最新 profile 清單 */
  refreshProfiles: () => Promise<void>;
  /** 新增 profile；成功回傳新 id（供呼叫端切過去）*/
  createProfile: (name: string) => Promise<string | null>;
  renameProfile: (id: string, name: string) => Promise<void>;
  deleteProfile: (id: string) => Promise<void>;
}

export const usePortfolioProfileStore = create<ProfileStore>()(
  persist(
    (set, get) => ({
      activeProfileId: 'me',
      profiles: [DEFAULT_PROFILE],

      setActiveProfile: (id) => set({ activeProfileId: id }),

      refreshProfiles: async () => {
        if (typeof window === 'undefined') return;
        try {
          const res = await fetch('/api/portfolio/profiles', { cache: 'no-store' });
          if (!res.ok) return;
          const json = await res.json();
          const profiles = (json.data?.profiles ?? json.profiles ?? []) as PortfolioProfile[];
          if (!Array.isArray(profiles) || profiles.length === 0) return;
          set({ profiles });
          // 目前選的 profile 已被刪 → 退回「我的」
          if (!profiles.some(p => p.id === get().activeProfileId)) {
            set({ activeProfileId: 'me' });
          }
        } catch { /* silent — 保留現有清單 */ }
      },

      createProfile: async (name) => {
        if (typeof window === 'undefined') return null;
        try {
          const res = await fetch('/api/portfolio/profiles', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name }),
          });
          if (!res.ok) return null;
          const json = await res.json();
          const profile = (json.data?.profile ?? json.profile) as PortfolioProfile | undefined;
          await get().refreshProfiles();
          return profile?.id ?? null;
        } catch { return null; }
      },

      renameProfile: async (id, name) => {
        if (typeof window === 'undefined') return;
        try {
          await fetch('/api/portfolio/profiles', {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id, name }),
          });
          await get().refreshProfiles();
        } catch { /* silent */ }
      },

      deleteProfile: async (id) => {
        if (typeof window === 'undefined') return;
        try {
          await fetch(`/api/portfolio/profiles?id=${encodeURIComponent(id)}`, { method: 'DELETE' });
          if (get().activeProfileId === id) set({ activeProfileId: 'me' });
          await get().refreshProfiles();
        } catch { /* silent */ }
      },
    }),
    { name: 'portfolio-profile-v1' },
  ),
);

/** 給非 React 環境（store helper）同步取當前 profile id */
export function getActiveProfileId(): string {
  try {
    return usePortfolioProfileStore.getState().activeProfileId || 'me';
  } catch {
    return 'me';
  }
}
