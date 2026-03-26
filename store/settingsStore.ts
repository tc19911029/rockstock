import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export interface StrategyParams {
  kdMaxEntry: number;      // KD上限，超過不進場 (default: 88)
  deviationMax: number;    // 乖離MA20上限 (default: 0.20 = 20%)
  volumeRatioMin: number;  // 量比最低門檻 (default: 1.5)
  upperShadowMax: number;  // 上影線最大比例 (default: 0.20 = 20%)
  minScore: number;        // 最低分數門檻 (default: 4)
}

export const DEFAULT_STRATEGY: StrategyParams = {
  kdMaxEntry: 88,
  deviationMax: 0.20,
  volumeRatioMin: 1.5,
  upperShadowMax: 0.20,
  minScore: 4,
};

interface SettingsStore {
  notifyEmail: string;
  notifyMinScore: number;
  strategy: StrategyParams;
  setNotifyEmail: (email: string) => void;
  setNotifyMinScore: (score: number) => void;
  setStrategy: (params: Partial<StrategyParams>) => void;
  resetStrategy: () => void;
}

export const useSettingsStore = create<SettingsStore>()(
  persist(
    (set) => ({
      notifyEmail: '',
      notifyMinScore: 5,
      strategy: DEFAULT_STRATEGY,
      setNotifyEmail: (email) => set({ notifyEmail: email }),
      setNotifyMinScore: (score) => set({ notifyMinScore: score }),
      setStrategy: (params) => set(s => ({ strategy: { ...s.strategy, ...params } })),
      resetStrategy: () => set({ strategy: DEFAULT_STRATEGY }),
    }),
    { name: 'settings-v3' }  // bump version since we added fields
  )
);
