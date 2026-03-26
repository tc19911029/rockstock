import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import {
  StrategyConfig,
  BUILT_IN_STRATEGIES,
  ZHU_V1,
} from '@/lib/strategy/StrategyConfig';

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
  // 策略版本管理
  activeStrategyId: string;
  customStrategies: StrategyConfig[];
  setNotifyEmail: (email: string) => void;
  setNotifyMinScore: (score: number) => void;
  setStrategy: (params: Partial<StrategyParams>) => void;
  resetStrategy: () => void;
  // 策略版本管理 actions
  setActiveStrategy: (id: string) => void;
  addCustomStrategy: (s: StrategyConfig) => void;
  deleteCustomStrategy: (id: string) => void;
  getActiveStrategy: () => StrategyConfig;
}

export const useSettingsStore = create<SettingsStore>()(
  persist(
    (set, get) => ({
      notifyEmail: '',
      notifyMinScore: 5,
      strategy: DEFAULT_STRATEGY,
      activeStrategyId: 'zhu-v1',
      customStrategies: [],
      setNotifyEmail: (email) => set({ notifyEmail: email }),
      setNotifyMinScore: (score) => set({ notifyMinScore: score }),
      setStrategy: (params) => set(s => ({ strategy: { ...s.strategy, ...params } })),
      resetStrategy: () => set({ strategy: DEFAULT_STRATEGY }),
      setActiveStrategy: (id) => set({ activeStrategyId: id }),
      addCustomStrategy: (s) =>
        set(state => ({ customStrategies: [...state.customStrategies, s] })),
      deleteCustomStrategy: (id) =>
        set(state => ({
          customStrategies: state.customStrategies.filter(s => s.id !== id),
          // If the deleted strategy was active, fall back to zhu-v1
          activeStrategyId:
            state.activeStrategyId === id ? 'zhu-v1' : state.activeStrategyId,
        })),
      getActiveStrategy: () => {
        const { activeStrategyId, customStrategies } = get();
        const all = [...BUILT_IN_STRATEGIES, ...customStrategies];
        return all.find(s => s.id === activeStrategyId) ?? ZHU_V1;
      },
    }),
    { name: 'settings-v4' }  // bump version since we added strategy version fields
  )
);
