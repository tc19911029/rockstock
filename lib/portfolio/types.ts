import type { Candle } from '../../types';
import type { MarketId, StockScanResult } from '../scanner/types';

/**
 * 使用者持倉一筆紀錄
 *
 * entryKbar 是進場當日的 OHLC 快照，固定不變，用於停損計算
 *（朱 5 步驟法 S1：停損 = max(進場 K 棒最低點, 成本 × 0.93)）
 */
export interface Holding {
  id: string;
  symbol: string;
  name: string;
  market: MarketId;
  shares: number;
  costPrice: number;
  buyDate: string;       // YYYY-MM-DD
  entryKbar?: Candle;    // 進場日 OHLC 快照（首次新增時可能尚未取得，後續補入）
  notes?: string;
}

/** 每檔持倉的當日監控結果 */
export interface HoldingMonitor {
  symbol: string;
  name: string;
  market: MarketId;
  shares: number;
  costPrice: number;
  currentPrice: number;
  marketValue: number;       // 當前市值
  unrealizedPL: number;      // 未實現損益（金額）
  unrealizedPLPct: number;   // 未實現損益（%）
  stopLossPrice: number;     // 動態停損價
  stopLossDistancePct: number; // 距停損還有幾 %（負值表示已破）
  /** 停損計算依據（書本條文+數值），UI 顯示用 */
  stopLossBasis: string;
  action: HoldingAction;
  reasons: string[];         // 為什麼建議這個動作（書本條文）
  warnings: string[];        // 還沒到觸發但要注意的事
}

export type HoldingAction =
  | 'HOLD'                // 繼續持有
  | 'SELL_STOP'           // 跌破停損
  | 'SELL_TREND'          // 頭頭低（轉為空頭）
  | 'SELL_PROHIBITION'    // 觸發戒律
  | 'SELL_ELIMINATION'    // 觸發淘汰法
  | 'SELL_DABAN_BREAK'    // 打板：跌破漲停 K 棒最低點
  | 'WATCH';              // 接近停損但未破

/** 候選池中的買進建議 */
export interface BuyRecommendation {
  symbol: string;
  name: string;
  market: MarketId;
  rank: number;             // 1-based
  entryPrice: number;       // 建議進場價（候選當日收盤）
  stopLossPrice: number;    // 預期停損價（用 -7% 估算，進場後改用實際 K 低）
  stopLossDistancePct: number;
  suggestedShares: number;  // 建議股數（已對齊單位：TW=1000 股=1 張、CN=100 股=1 手）
  suggestedAmount: number;  // 建議部位金額
  positionPct: number;      // 佔總資金 %
  riskAmount: number;       // 觸發停損會虧多少錢（正值）
  reasons: string[];        // 進場理由（書本條文）
  scanResult: StockScanResult;
}

/** 接近進場點但還沒符合的觀察清單 */
export interface WatchItem {
  symbol: string;
  name: string;
  market: MarketId;
  currentPrice: number;
  reason: string;           // 等什麼條件
}

/** 單市場帳戶快照（TW/CN 各一筆） */
export interface MarketAccountSummary {
  market: MarketId;
  cashBalance: number;
  invested: number;
  totalCapital: number;
  cashAvailable: number;
  unrealizedPL: number;
  unrealizedPLPct: number;
}

/** 每日操作清單（API 回傳結構） */
export interface DailyActionList {
  asOfDate: string;
  market: MarketId | 'ALL';
  /** 兩市場合計（top-level 摘要） */
  totalCapital: number;
  invested: number;
  cashAvailable: number;
  cashReservePct: number;
  unrealizedPL: number;
  unrealizedPLPct: number;
  holdings: HoldingMonitor[];
  buyRecommendations: BuyRecommendation[];
  watchList: WatchItem[];
  /** 各市場分帳（TW/CN 獨立帳戶） */
  accounts: MarketAccountSummary[];
}

/** 資金分配的設定參數（呼叫端負責算 cashAvailable，allocator 不管 reserve） */
export interface CapitalAllocationConfig {
  totalCapital: number;          // 總資產 = 持倉市值 + 現金（用於 2% 風險基數）
  maxPositions: number;          // 同時持倉上限（TW:5, CN:3）
  riskPerTradePct: number;       // 單筆最大風險 %（朱+林+通用 2% 法則）
  maxPositionPct: number;        // 單檔部位上限 %（自加安全閥，預設 20）
  shareUnit: number;             // 最小單位（TW=1000 股=1 張，CN=100 股=1 手）
}

export const DEFAULT_TW_CONFIG: Omit<CapitalAllocationConfig, 'totalCapital'> = {
  maxPositions: 5,
  riskPerTradePct: 2,
  maxPositionPct: 20,
  shareUnit: 1000,
};

export const DEFAULT_CN_CONFIG: Omit<CapitalAllocationConfig, 'totalCapital'> = {
  maxPositions: 3,
  riskPerTradePct: 2,
  maxPositionPct: 25,    // CN 持倉少所以單檔可略大
  shareUnit: 100,
};
