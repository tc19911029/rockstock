/**
 * Memory / Reflect — P6
 *
 * 設計核心紅線（呼應 plan §0 + §-1）：
 *   - Memory 是 **純文字報告**（markdown），給人讀的
 *   - **不回寫到** agent prompt / question.json / agent 邏輯
 *   - **不影響** 下次 prepare-batch 或 skill 行為
 *   - 不調整任何 agent 權重（也沒「權重」這東西，§0 規則式整合不是加權平均）
 *
 * 用途：
 *   - 使用者每週讀一次，看：
 *     * 各 agent 命中率長期趨勢
 *     * 衝突案例（4 個面向 verdict 不一致 → backtest 證明誰對）
 *     * decisionPath 分佈是否健康
 *   - 如果發現問題，由**使用者親手**修改 source（如調 chipSource 篩選條件），
 *     而不是讓 reflect 自動把學習注入 agent
 */

export const MEMORY_SCHEMA_VERSION = 1 as const;

/** Memory 檔案類型 */
export type MemoryKind =
  | 'technical'   // Technical Agent 表現紀錄
  | 'news'        // News Agent 紀錄
  | 'chip'        // Chip Agent 紀錄
  | 'fundamental' // Fundamental Agent 紀錄
  | 'risk'        // Risk Agent 紀錄
  | 'debate'      // Bull/Bear 辯論 case 分析
  | 'decision'    // Decision Agent path 分佈
  | 'conflicts'   // 跨 agent 衝突 case
  | 'weekly';     // 每週完整報告（按 ISO 週存）

export const MEMORY_KINDS: MemoryKind[] = [
  'technical', 'news', 'chip', 'fundamental', 'risk',
  'debate', 'decision', 'conflicts', 'weekly',
];

/** 給 skill 讀的 reflect question — 整理區間資料供 LLM 寫報告 */
export interface ReflectQuestion {
  schemaVersion: typeof MEMORY_SCHEMA_VERSION;
  from: string;
  to: string;
  market: 'TW' | 'CN';
  generatedAt: string;

  /** Backtest 區間 summary（lib/agents/backtest/summary 產的）*/
  backtestSummary: unknown;  // BacktestSummary，避開循環依賴

  /** 每日 decision 索引（給 skill 看哪些 case 值得舉例）*/
  decisions: Array<{
    date: string;
    symbols: string[];
    actionDistribution: { buy: number; watch: number; skip: number };
  }>;

  /** 衝突 case 索引（4 個面向 verdict 不一致的 symbol）*/
  conflictCases: Array<{
    date: string;
    symbol: string;
    verdictsByAgent: Record<string, string | null>;
    action: string;
    decisionPath: string;
    /** 對應的 backtest d5/d20 — 給 skill 判斷誰對誰錯 */
    d5Return: number | null;
    d20Return: number | null;
  }>;

  /** Skill 應寫的 markdown 輸出路徑 */
  outputPaths: Record<MemoryKind, string>;
}

/** Memory file metadata（給 GET API 用）*/
export interface MemoryFileMeta {
  kind: MemoryKind;
  path: string;
  exists: boolean;
  updatedAt: string | null;
  sizeBytes: number;
  /** 第一行作為 title（通常是 markdown # title）*/
  title: string | null;
}
