/**
 * 陸股情緒系統 — 回測事件型別（P2）
 *
 * 事件 = 某日某 agent source 對某股的推薦/分層判定，凍結當下的分數切片與
 * 情緒階段，隔日開盤進場（settleBaseline 一字板 no_fill 守衛），報酬不持久化
 * （讀取時從 K 線即時 derive，同 youtube reco 慣例）。
 *
 * 複合主鍵：(date, agentSource, code) → id = `${date}:${agentSource}:${code}`。
 * C 類（避開）也入事件 — 驗證「避開」是否真的該避（cohort 語意 win=跌）。
 */

import type { RecoBaseline } from '@/lib/backtest/eventBaseline';
import type { CnAgentSource, CnBoardKind, CnRecoMode, CnTier, EmotionStage } from '../types';

export interface CnRecoEvent {
  /** `${date}:${agentSource}:${code}` */
  id: string;
  date: string;
  agentSource: CnAgentSource;
  /** 6 位裸碼 */
  code: string;
  name: string;
  /** code.SS / code.SZ；北交所 code.BJ（結算時 no_data） */
  symbol: string;
  board: CnBoardKind;
  tier: CnTier;
  /** v0 規則簡化版操作模式（P3 tacticClassifier 上線後細化） */
  mode: CnRecoMode;
  totalScore: number;
  /** 凍結的子分切片（key ⊆ CN_EMOTION_SIGNAL_SPECS keys；缺值 null） */
  scoreBreakdown: Record<string, number | null>;
  /** 決策當下的情緒階段（凍結 — 「模式×階段」交叉表的列 key） */
  sentimentPhase: EmotionStage;
  reason: string;
  /** 結算前 null；settlePendingEvents 寫入後凍結 */
  baseline: RecoBaseline | null;
}

export interface CnRecoEventsFile {
  schemaVersion: number;
  date: string;
  generatedAt: string;
  /** 產生事件當下的硬分版本註記（對照 master_decision 用） */
  events: CnRecoEvent[];
}
