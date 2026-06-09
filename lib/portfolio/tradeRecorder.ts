/**
 * Trade Recorder — 已平倉交易事實表（Phase 1.1）
 *
 * 設計原則：
 *   - **Append-only**：trades.json 一旦寫入不可改（封存後不可變，類比 Layer 1）
 *   - **搬家不複製**：close-trade 把持股從 holdings.json 移除、append 進 trades.json
 *   - **含費損益單一事實**：netPnL 一律走 lib/portfolio/fees.ts 的 calcNetPnL
 *   - **trades.json 與 paper-portfolio 完全分離**：紙上模擬不混入實盤
 *   - **每月分檔備援**：closed/{YYYY-MM}.json 月度切割避免單檔過大
 *
 * Schema：
 *   data/agents/portfolio/trades.json
 *   {
 *     schemaVersion: 1,
 *     trades: ClosedTrade[],
 *     updatedAt: string
 *   }
 *
 * 為什麼放 lib/portfolio 而不是 lib/agents/portfolio：
 *   - 與 fees.ts 同層（資金/績效相關核心）
 *   - agents/portfolio 是 mini-agent review 範圍（與 trades 解耦）
 */

import path from 'node:path';
import { promises as fs } from 'node:fs';
import { atomicFsPut } from '@/lib/storage/atomicFsPut';
import { calcNetPnL } from '@/lib/portfolio/fees';
import { profileDir, DEFAULT_PROFILE_ID } from '@/lib/portfolio/profiles';
import type { MarketId } from '@/lib/scanner/types';

export const TRADES_SCHEMA_VERSION = 1 as const;

export type TradeExitReason =
  | 'target_hit'        // 達 target1/target2
  | 'stop_loss'         // 跌破 stopLoss
  | 'discipline_break'  // 戒律觸發強出
  | 'risk_red'          // 風控紅燈強出
  | 'hold_days_max'     // 持有天數上限
  | 'manual'            // 人工判斷出場
  | 'swap'              // 換股出場
  | 'other';

export interface ClosedTrade {
  schemaVersion: typeof TRADES_SCHEMA_VERSION;
  tradeId: string;                          // ${symbol}-${entryDate}-${exitDate}
  symbol: string;
  name: string;
  market: MarketId;
  industry?: string;

  // 進場（從 holding 拷貝）
  entryDate: string;
  entryPrice: number;
  shares: number;
  entryDecisionRunId?: string;

  // 出場
  exitDate: string;
  exitPrice: number;
  exitReason: TradeExitReason;
  exitNote?: string;                        // exitReason='manual'/'other' 時補述
  holdDays: number;

  // 含費損益（走 calcNetPnL）
  grossPnL: number;                         // shares × (exit - entry)（無扣費）
  fees: number;                             // 買+賣手續費+稅
  netPnL: number;                           // grossPnL - fees
  netReturnPct: number;                     // netPnL / (shares × entryPrice) × 100

  // 進場時設定的關卡（從 holding 拷貝，後驗用）
  stopLoss?: number;
  target1?: number;
  target2?: number;

  // 並陳訊號（進場時凍結；可選，未來 multi-agent 整合時填）
  triggerSignal?: string;                   // 字母 N/B/Q/...
  matchedMethods?: string[];                // 多軌共振

  notes?: string;
  createdAt: string;
}

export interface TradesFile {
  schemaVersion: typeof TRADES_SCHEMA_VERSION;
  trades: ClosedTrade[];
  updatedAt: string;
}

const TRADES_DIR = path.join(process.cwd(), 'data', 'agents', 'portfolio');
const TRADES_FILE = path.join(TRADES_DIR, 'trades.json');
const CLOSED_MONTHLY_DIR = path.join(TRADES_DIR, 'closed');

/** trades.json 路徑（預設 'me' = legacy；其他 profile = data/portfolios/{id}/trades.json）*/
function tradesFileFor(profileId: string): string {
  const dir = profileDir(profileId);
  return dir ? path.join(dir, 'trades.json') : TRADES_FILE;
}
/** 月度分檔目錄（預設 'me' = legacy；其他 profile = data/portfolios/{id}/closed）*/
function closedDirFor(profileId: string): string {
  const dir = profileDir(profileId);
  return dir ? path.join(dir, 'closed') : CLOSED_MONTHLY_DIR;
}

export async function loadTrades(profileId: string = DEFAULT_PROFILE_ID): Promise<TradesFile> {
  try {
    const raw = await fs.readFile(tradesFileFor(profileId), 'utf-8');
    return JSON.parse(raw) as TradesFile;
  } catch {
    return {
      schemaVersion: TRADES_SCHEMA_VERSION,
      trades: [],
      updatedAt: new Date().toISOString(),
    };
  }
}

async function saveTrades(file: TradesFile, profileId: string = DEFAULT_PROFILE_ID): Promise<void> {
  const target = tradesFileFor(profileId);
  await fs.mkdir(path.dirname(target), { recursive: true });
  file.updatedAt = new Date().toISOString();
  await atomicFsPut(target, JSON.stringify(file, null, 2));
}

async function appendMonthlyArchive(trade: ClosedTrade, profileId: string = DEFAULT_PROFILE_ID): Promise<void> {
  const ym = trade.exitDate.slice(0, 7); // YYYY-MM
  const closedDir = closedDirFor(profileId);
  await fs.mkdir(closedDir, { recursive: true });
  const file = path.join(closedDir, `${ym}.json`);
  let existing: TradesFile;
  try {
    const raw = await fs.readFile(file, 'utf-8');
    existing = JSON.parse(raw) as TradesFile;
  } catch {
    existing = { schemaVersion: TRADES_SCHEMA_VERSION, trades: [], updatedAt: '' };
  }
  existing.trades.push(trade);
  existing.updatedAt = new Date().toISOString();
  await atomicFsPut(file, JSON.stringify(existing, null, 2));
}

export interface CloseTradeInput {
  symbol: string;
  name: string;
  market: MarketId;
  industry?: string;
  entryDate: string;
  entryPrice: number;
  shares: number;
  entryDecisionRunId?: string;
  stopLoss?: number;
  target1?: number;
  target2?: number;
  triggerSignal?: string;
  matchedMethods?: string[];

  exitDate: string;
  exitPrice: number;
  exitReason: TradeExitReason;
  exitNote?: string;
  notes?: string;
}

export function diffDays(fromDate: string, toDate: string): number {
  const a = Date.parse(fromDate);
  const b = Date.parse(toDate);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return 0;
  return Math.round((b - a) / 86400000);
}

/** 純函式：給輸入算 ClosedTrade（不寫檔，給合約測試用）*/
export function buildClosedTrade(input: CloseTradeInput, now = new Date()): ClosedTrade {
  const { pnl: netPnL, pnlPct: netReturnPct } = calcNetPnL(
    input.symbol, input.shares, input.entryPrice, input.exitPrice,
  );
  const grossPnL = input.shares * (input.exitPrice - input.entryPrice);
  const fees = grossPnL - netPnL;          // 反推手續費+稅
  return {
    schemaVersion: TRADES_SCHEMA_VERSION,
    tradeId: `${input.symbol}-${input.entryDate}-${input.exitDate}`,
    symbol: input.symbol,
    name: input.name,
    market: input.market,
    industry: input.industry,
    entryDate: input.entryDate,
    entryPrice: input.entryPrice,
    shares: input.shares,
    entryDecisionRunId: input.entryDecisionRunId,
    exitDate: input.exitDate,
    exitPrice: input.exitPrice,
    exitReason: input.exitReason,
    exitNote: input.exitNote,
    holdDays: diffDays(input.entryDate, input.exitDate),
    grossPnL,
    fees,
    netPnL,
    netReturnPct,
    stopLoss: input.stopLoss,
    target1: input.target1,
    target2: input.target2,
    triggerSignal: input.triggerSignal,
    matchedMethods: input.matchedMethods,
    notes: input.notes,
    createdAt: now.toISOString(),
  };
}

/** Append 一筆 trade 到 trades.json + 月度分檔（profileId 決定寫哪組持倉檔案）*/
export async function appendTrade(input: CloseTradeInput, profileId: string = DEFAULT_PROFILE_ID): Promise<ClosedTrade> {
  // 基本不變式
  if (input.entryDate > input.exitDate) {
    throw new Error(`exitDate (${input.exitDate}) 不可早於 entryDate (${input.entryDate})`);
  }
  const today = new Date().toISOString().slice(0, 10);
  if (input.exitDate > today) {
    throw new Error(`exitDate (${input.exitDate}) 不可為未來日期 (today ${today})`);
  }
  if (input.exitPrice <= 0) throw new Error('exitPrice 必須為正數');
  if (input.shares <= 0) throw new Error('shares 必須為正數');

  const trade = buildClosedTrade(input);

  // dedup：相同 tradeId 不可重複（append-only 不蓋寫）
  const file = await loadTrades(profileId);
  if (file.trades.some(t => t.tradeId === trade.tradeId)) {
    throw new Error(`tradeId ${trade.tradeId} 已存在；append-only 不可重複寫入`);
  }
  file.trades.push(trade);
  await saveTrades(file, profileId);
  await appendMonthlyArchive(trade, profileId);
  return trade;
}

export const TRADES_PATHS = {
  master: TRADES_FILE,
  monthlyDir: CLOSED_MONTHLY_DIR,
} as const;
