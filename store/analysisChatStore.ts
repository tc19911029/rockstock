import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export interface AnalysisChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

interface AnalysisChatStore {
  /** 走圖問老師的對話（條件 ↔ 問老師 切換時不會掉）*/
  messages: AnalysisChatMessage[];
  setMessages: (m: AnalysisChatMessage[]) => void;
  /** 用 updater fn 來原子更新（streaming 時需要） */
  updateMessages: (updater: (prev: AnalysisChatMessage[]) => AnalysisChatMessage[]) => void;
  clear: () => void;
}

export const useAnalysisChatStore = create<AnalysisChatStore>()(
  persist(
    (set) => ({
      messages: [],
      setMessages: (m) => set({ messages: m }),
      updateMessages: (updater) => set((s) => ({ messages: updater(s.messages) })),
      clear: () => set({ messages: [] }),
    }),
    { name: 'analysis-chat-v1' },
  ),
);
