/**
 * Portfolio 持股追蹤 + Backtest schema
 *
 * 持股不進 candidates pool — 它已是進場後的部位，每日跑 mini-agent 評估。
 *
 * Mini-agent 範圍（不跑 4 個全套，效率優先）：
 *   - Technical Agent：技術面是否轉弱、跌破停損
 *   - Risk Agent：事件風險、過熱、停損條件
 *   - News Agent：新利空 / 利多出盡
 *   - 整合：產出 hold_strong/hold_observe/add/reduce/take_profit/stop_loss/no_add
 */

import type { MarketId } from '@/lib/scanner/types';

export const PORTFOLIO_SCHEMA_VERSION = 1 as const;

export interface PortfolioPartialExitExecution {
  /** 建議減碼的訊號交易日（YYYY-MM-DD），用來避免把不同訊號誤當同一次執行。 */
  signalDate: string;
  signalType: string;
  executedAt: string;
  executionPrice?: number;
  sharesBefore: number;
  sharesSold: number;
  sharesRemaining: number;
}

export interface PortfolioExecutionState {
  /** 建倉時股數；舊資料第一次確認減碼時補建。 */
  initialShares: number;
  partialExits: PortfolioPartialExitExecution[];
}

export interface PortfolioRiskState {
  activeStopLoss: number;
  method: string;
  sourceDate: string;
  updatedAt: string;
}

// ────────────────────────────────────────────────────────────────────────────
// 持股
// ────────────────────────────────────────────────────────────────────────────

export interface PortfolioHolding {
  schemaVersion: typeof PORTFOLIO_SCHEMA_VERSION;
  symbol: string;
  name: string;
  market: MarketId;
  industry?: string;

  /** 進場日期 YYYY-MM-DD */
  entryDate: string;
  /** 進場價（手動輸入或從 FinalDecision.entryPrice）*/
  entryPrice: number;
  /** 持股張數（TW: 千股；CN: 100 股）*/
  shares: number;

  /** 對應的 Multi-Agent 決策（可選；若手動進場可空）*/
  entryDecisionRunId?: string;

  /** 進場時設定的停損/停利價 */
  stopLoss?: number;
  target1?: number;
  target2?: number;

  /** 使用者已確認執行的分批交易；不能只靠 K 線反推「昨天應該有賣」。 */
  executionState?: PortfolioExecutionState;
  /** 已套用的策略停損與來源，供每日建議、推播及稽核共用。 */
  riskState?: PortfolioRiskState;

  /** 自訂備註 */
  notes?: string;

  /**
   * UI-only 富欄位 passthrough（v12 進場體驗：entryKbar / triggerPrice /
   * operationMode / entryPattern / recentHigh / consolidationLow / vBottom 等）。
   *
   * 為什麼是 opaque blob：server 端 mini-agent / 月報 / close-trade 只讀核心欄位，
   * 但前端 /portfolio 走圖停損停利邏輯需要這些欄位。把它們原樣帶著走，
   * server 不解讀、UI hydration 時再展開回 store。reports 一律忽略此欄位。
   */
  ui?: Record<string, unknown>;

  /** 部位狀態 */
  status: 'open' | 'closed';
  /** 出場資訊（status=closed 時填）*/
  closedAt?: string;
  closedPrice?: number;
  closeReason?: string;

  /** Audit timestamps */
  createdAt: string;
  updatedAt: string;
}

/** 全市場持股檔（單一 JSON）*/
export interface PortfolioFile {
  schemaVersion: typeof PORTFOLIO_SCHEMA_VERSION;
  holdings: PortfolioHolding[];
  updatedAt: string;
}

// ────────────────────────────────────────────────────────────────────────────
// Daily Review（每日對持股跑 mini-agent 後寫）
// ────────────────────────────────────────────────────────────────────────────

/**
 * 持股操作建議 enum
 *
 *   hold_strong   : 強勢續抱（技術 pass + 風控 green）
 *   hold_observe  : 續抱但觀察（技術 watch 或 風控 yellow）
 *   add           : 加碼（技術 pass + 風控 green + 突破關鍵價）
 *   reduce        : 減碼（技術 watch + 風控 yellow + 漲多）
 *   take_profit   : 停利（達 target1/target2，或 技術 fail）
 *   stop_loss     : 停損（跌破 stopLoss 或 風控 red）
 *   no_add        : 不建議再加碼（已過熱）
 */
export type PortfolioAction =
  | 'hold_strong'
  | 'hold_observe'
  | 'add'
  | 'reduce'
  | 'take_profit'
  | 'stop_loss'
  | 'no_add';

/** 單檔持股的當日 review */
export interface PortfolioHoldingReview {
  symbol: string;
  name: string;
  market: MarketId;

  /** 從 holdings.json 拷貝 */
  entryDate: string;
  entryPrice: number;
  shares: number;

  /** 當日狀態 */
  currentPrice: number;
  returnPct: number;        // (currentPrice - entryPrice) / entryPrice
  daysHeld: number;

  /** Mini-agent verdict 並列（§0 隔離 — 不混合加權）*/
  technical: { verdict: 'pass' | 'watch' | 'fail'; overview: string; verdictReason: string } | null;
  risk:      { verdict: 'green' | 'yellow' | 'red'; overview: string; verdictReason: string } | null;
  news:      { verdict: 'pass' | 'watch' | 'fail'; overview: string; verdictReason: string } | null;

  /** 整合操作建議（規則式，不加權平均）*/
  action: PortfolioAction;

  /** 推導 action 命中的規則 path（給 contract 驗證）*/
  actionPath: string;

  /** 解釋為何給此 action（一句話）*/
  reasoning: string;

  /** 關鍵價位（給 UI 顯示用）*/
  keyPriceLevels: {
    supportPrice?: number;     // 支撐（如 MA20）
    resistancePrice?: number;  // 壓力
    stopLossPrice?: number;
    takeProfitPrice?: number;
  };

  /** 各 agent run 的檔案參考 */
  agentRunPaths?: {
    technical?: string;
    risk?: string;
    news?: string;
  };
}

/** 該日所有持股的 Review */
export interface PortfolioReviewFile {
  schemaVersion: typeof PORTFOLIO_SCHEMA_VERSION;
  date: string;
  generatedAt: string;
  reviews: PortfolioHoldingReview[];
  /** Mini-agent run 是否完成 */
  agentRunsCompleted: boolean;
}

// ────────────────────────────────────────────────────────────────────────────
// Mini-Agent question（給 portfolio review skill 用）
// ────────────────────────────────────────────────────────────────────────────

/** 持股 mini-agent question — skill 讀此檔產 review answer */
export interface PortfolioReviewQuestion {
  schemaVersion: typeof PORTFOLIO_SCHEMA_VERSION;
  date: string;
  holdings: Array<{
    symbol: string;
    name: string;
    market: MarketId;
    entryDate: string;
    entryPrice: number;
    shares: number;
    stopLoss?: number;
    target1?: number;
    target2?: number;
    strategyContext?: {
      triggerSignal?: unknown;
      operationMode?: unknown;
      managementStrategy?: unknown;
    };
    /** 當日相關資料（從 prepare 時 fetch 好）*/
    context: {
      currentPrice: number | null;
      candidateRow?: unknown;  // 從 L4 撈（若該檔在 L4 中）
      chip?: unknown;          // 從 /api/chip 撈
      news?: unknown;          // 從 /api/news 撈
    };
  }>;
  outputPath: string;  // skill 應寫到 data/agents/portfolio/reviews/{date}.json
}
