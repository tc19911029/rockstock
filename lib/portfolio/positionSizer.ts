/**
 * 部位大小引擎（Phase 2.1）
 *
 * 4 種 mode 統一入口（純函式 + dispatcher）：
 *   - fixedFraction：每次 totalCapital × fixedFractionPct（樣本不足時用）
 *   - kelly：半 Kelly = (b×p - q) / b × kellyFraction；需要 letterStats
 *   - letterAware：fixedFraction × letterWeight × resonanceBonus（書本 + 回測反推）
 *   - riskParity：以 stopLoss 距離反向加權，每筆風險固定 riskPerTradePct
 *
 * 流程：
 *   1. raw mode → 算出 rawCapital
 *   2. riskGuards 套上限（單檔/行業/軌道/MDD 紅燈降槓桿）
 *   3. 對齊 lot size（TW 1000 / CN 100）
 *   4. 算買進手續費 + 含費總成本
 *
 * 不變式：
 *   - letterWeights 不可拍腦袋（合約測試 sizer-no-self-invented-factors 守）
 *   - 落後紅燈時動 sizer、**不**動選股條件（規則 #5）
 */

import { FEE_RATES } from '@/lib/portfolio/fees';
import type { MarketId } from '@/lib/scanner/types';

export const SIZING_SCHEMA_VERSION = 1 as const;

export type SizingMode = 'fixedFraction' | 'kelly' | 'letterAware' | 'riskParity';

export interface SizingConfig {
  schemaVersion: typeof SIZING_SCHEMA_VERSION;
  mode: SizingMode;
  /** 單檔最大占資金比例（規則上限）*/
  perPositionMaxPct: number;
  /** 同行業最大占資金比例 */
  perIndustryMaxPct: number;
  /** 同軌道（bullish/reversal/system/mechanical）最大占資金比例 */
  perTrackMaxPct: number;
  /** 組合 MDD 紅燈門檻（觸發時 raw × 0.5）*/
  portfolioMddTriggerPct: number;
  /** Kelly 折扣（0.5 = 半 Kelly，0.25 = 四分之一 Kelly）*/
  kellyFraction: number;
  /** fixedFraction 模式每檔配資百分比 */
  fixedFractionPct: number;
  /** riskParity 模式每筆風險百分比 */
  riskPerTradePct: number;
  /** 字母權重（reflect 從回測反推，不可拍腦袋）*/
  letterWeights: Record<string, number>;
  /** 共振組合加成 */
  resonanceBonus: Record<string, number>;
}

export interface LetterStats {
  winRate: number;      // 百分比形式（54.4 而非 0.544）
  maxGainMedian: number;
  maxLossMedian: number; // 負值
  samples: number;
}

export interface ExistingHolding {
  symbol: string;
  industry?: string;
  track?: string;
  currentValue: number;
}

export interface SizingRequest {
  totalCapital: number;
  candidatePrice: number;
  market: MarketId;
  letter?: string;             // triggerSignal
  matchedMethods?: string[];   // 共振字母（含主字母）
  industry?: string;
  track?: string;
  candidateStopLoss?: number;
  existingHoldings: ExistingHolding[];
  letterStatsByLetter?: Record<string, LetterStats>;
  /** Optional MDD 觸發（呼叫端從 growthPath 或 trades 算出來傳入）*/
  currentPortfolioMddPct?: number;
}

export interface SizingResult {
  mode: SizingMode;
  rawCapital: number;
  cappedCapital: number;
  shares: number;
  lots: number;
  capitalUsed: number;
  capitalUsedPct: number;
  buyFee: number;
  totalCost: number;
  appliedGuards: string[];
  warnings: string[];
  // mode-specific metadata
  letterMultiplier?: number;
  resonanceMultiplier?: number;
  kellyFraction?: number;
  stopLossDistancePct?: number;
  reasoning: string;
}

// ────────────────────────────────────────────────────────────────────────────
// 預設 config（letterWeights 從 data/backtest_results_per_letter.json 反推）
// ────────────────────────────────────────────────────────────────────────────

export const DEFAULT_LETTER_WEIGHTS: Readonly<Record<string, number>> = {
  // 主力字母（從 backtest 半 Kelly 反推、normalize 至 [0.3, 1.0]）
  // 2026-05-21 回測：J(was G) 半K 0.283=1.0；N 0.187=0.76；M 0.160=0.70；E 0.148=0.67
  J: 1.0,    // ABC 突破（前 G alias）— 樣本 50、勝率 68%、d5+6.23%
  N: 0.76,   // V 形反轉 — 樣本 350、勝率 56%、d5+3.18%
  M: 0.70,   // 突破軌道線 — 樣本 76、勝率 56%、d5+1.98%
  E: 0.67,   // 缺口 — 樣本 95、勝率 53.5%、d5+1.52%
  B: 0.65,   // 回後買上漲 — 樣本 228、勝率 54.4%、d5+2.66%
  Q: 0.62,   // 三均線戰法 — 樣本 411、勝率 54.4%、d5+2.23%
  P: 0.60,   // 高檔拉回 — 樣本 146、勝率 49.6%、d5+1.78%
  L: 0.52,   // 過大量黑 K（前 H alias）— 樣本 67、勝率 53.7%
  C: 0.48,   // 盤整突破 — 樣本 36（不足）、勝率 51.4%
  K: 0.46,   // K 線橫盤（前 I alias）— 樣本 73、勝率 50%
  F: 0.37,   // V 型反轉(反轉軌) — 樣本 312、勝率 46.2%（最弱）
  // 樣本不足者預設 0.5（不偏好不排斥）
  A: 0.5,    // 六條件池子本身
  D: 0.5,    // 一字底（樣本 < 30）
  O: 0.5,    // 打底完成（樣本 < 30）
  R: 0.5,    // 乖離率機械軌（非書本，保留中性）
};

export const DEFAULT_RESONANCE_BONUS: Readonly<Record<string, number>> = {
  // 從 backtest 共振組合反推（順序不重要，內部 sortJoin）
  'B+J': 1.30,   // 前 B+G d5+6.29% 勝率 72.1%（最強）
  'N+Q': 1.25,   // d5+5.92% 勝率 63.8%
  'B+E': 1.15,   // d5+4.88% 勝率 68%
};

export const DEFAULT_SIZING_CONFIG: SizingConfig = {
  schemaVersion: SIZING_SCHEMA_VERSION,
  mode: 'fixedFraction',
  perPositionMaxPct: 0.15,
  perIndustryMaxPct: 0.30,
  perTrackMaxPct: 0.60,
  portfolioMddTriggerPct: 0.10,
  kellyFraction: 0.5,
  fixedFractionPct: 0.10,
  riskPerTradePct: 0.01,
  letterWeights: { ...DEFAULT_LETTER_WEIGHTS },
  resonanceBonus: { ...DEFAULT_RESONANCE_BONUS },
};

// ────────────────────────────────────────────────────────────────────────────
// 4 個 mode 純函式
// ────────────────────────────────────────────────────────────────────────────

function fixedFractionMode(req: SizingRequest, config: SizingConfig): { rawCapital: number; reasoning: string } {
  const rawCapital = req.totalCapital * config.fixedFractionPct;
  return {
    rawCapital,
    reasoning: `fixedFraction：${(config.fixedFractionPct * 100).toFixed(1)}% × ${req.totalCapital.toLocaleString()} = ${rawCapital.toLocaleString()}`,
  };
}

function kellyMode(req: SizingRequest, config: SizingConfig): { rawCapital: number; reasoning: string; kellyFraction: number } {
  const stats = req.letter ? req.letterStatsByLetter?.[req.letter] : undefined;
  if (!stats || stats.samples < 30) {
    // 樣本不足 fallback 到 fixedFraction
    const ff = fixedFractionMode(req, config);
    return {
      rawCapital: ff.rawCapital,
      reasoning: `kelly fallback to fixedFraction（letter=${req.letter ?? 'unknown'} 樣本 ${stats?.samples ?? 0} < 30）；${ff.reasoning}`,
      kellyFraction: 0,
    };
  }
  const p = stats.winRate / 100;
  const q = 1 - p;
  const b = stats.maxGainMedian / Math.abs(stats.maxLossMedian || 0.01);
  const kelly = b > 0 ? Math.max(0, (b * p - q) / b) : 0;
  const halfKelly = kelly * config.kellyFraction;
  const rawCapital = req.totalCapital * halfKelly;
  return {
    rawCapital,
    reasoning: `kelly：letter=${req.letter} p=${p.toFixed(3)} b=${b.toFixed(2)} → kelly=${(kelly * 100).toFixed(1)}% × ${config.kellyFraction} = ${(halfKelly * 100).toFixed(1)}%；${rawCapital.toLocaleString()}`,
    kellyFraction: halfKelly,
  };
}

/** 共振組合 key 用排序後 join，避免「B+J」vs「J+B」不對齊 */
function resonanceKey(letters: readonly string[]): string {
  return [...letters].sort().join('+');
}

function letterAwareMode(req: SizingRequest, config: SizingConfig): {
  rawCapital: number; reasoning: string; letterMultiplier: number; resonanceMultiplier: number;
} {
  const baseFraction = config.fixedFractionPct;
  const letter = req.letter ?? 'A';
  const letterMultiplier = config.letterWeights[letter] ?? 0.5;
  let resonanceMultiplier = 1.0;
  let resonanceMatched: string | null = null;
  if (req.matchedMethods && req.matchedMethods.length >= 2) {
    // 嘗試所有 pair 找最強共振
    const sorted = [...req.matchedMethods].sort();
    let best = 1.0;
    for (let i = 0; i < sorted.length; i++) {
      for (let j = i + 1; j < sorted.length; j++) {
        const k = resonanceKey([sorted[i], sorted[j]]);
        if (config.resonanceBonus[k] && config.resonanceBonus[k] > best) {
          best = config.resonanceBonus[k];
          resonanceMatched = k;
        }
      }
    }
    resonanceMultiplier = best;
  }
  const finalFraction = baseFraction * letterMultiplier * resonanceMultiplier;
  const rawCapital = req.totalCapital * finalFraction;
  const resPart = resonanceMatched ? ` × 共振 ${resonanceMatched}=${resonanceMultiplier}` : '';
  return {
    rawCapital,
    reasoning: `letterAware：${(baseFraction * 100).toFixed(1)}% × 字母 ${letter}=${letterMultiplier}${resPart} = ${(finalFraction * 100).toFixed(2)}%；${rawCapital.toLocaleString()}`,
    letterMultiplier,
    resonanceMultiplier,
  };
}

function riskParityMode(req: SizingRequest, config: SizingConfig): {
  rawCapital: number; reasoning: string; stopLossDistancePct: number;
} {
  if (!req.candidateStopLoss || req.candidateStopLoss >= req.candidatePrice) {
    // 沒 stopLoss → fallback
    const ff = fixedFractionMode(req, config);
    return {
      rawCapital: ff.rawCapital,
      reasoning: `riskParity fallback to fixedFraction（缺 candidateStopLoss 或 ≥ entryPrice）；${ff.reasoning}`,
      stopLossDistancePct: 0,
    };
  }
  const stopDistance = (req.candidatePrice - req.candidateStopLoss) / req.candidatePrice;
  // 每筆風險固定金額 = totalCapital × riskPerTradePct
  // position 大小 = 風險金額 / 每股風險百分比
  const riskAmount = req.totalCapital * config.riskPerTradePct;
  const rawCapital = riskAmount / stopDistance;
  return {
    rawCapital,
    reasoning: `riskParity：每筆風險 ${(config.riskPerTradePct * 100).toFixed(1)}% × ${req.totalCapital.toLocaleString()} = ${riskAmount.toLocaleString()}；stopLoss 距 ${(stopDistance * 100).toFixed(1)}% → 部位 ${rawCapital.toLocaleString()}`,
    stopLossDistancePct: stopDistance,
  };
}

// ────────────────────────────────────────────────────────────────────────────
// 主入口：dispatch + riskGuards + lot align + fee
// ────────────────────────────────────────────────────────────────────────────

export function suggestPositionSize(req: SizingRequest, config: SizingConfig): SizingResult {
  let modeResult: {
    rawCapital: number; reasoning: string;
    letterMultiplier?: number; resonanceMultiplier?: number;
    kellyFraction?: number; stopLossDistancePct?: number;
  };
  switch (config.mode) {
    case 'fixedFraction': modeResult = fixedFractionMode(req, config); break;
    case 'kelly': modeResult = kellyMode(req, config); break;
    case 'letterAware': modeResult = letterAwareMode(req, config); break;
    case 'riskParity': modeResult = riskParityMode(req, config); break;
  }

  // 套 riskGuards
  const guarded = applyRiskGuards({
    rawCapital: modeResult.rawCapital,
    req,
    config,
  });

  // 對齊 lot size + 算手續費
  const lotSize = req.market === 'CN' ? 100 : 1000;
  const rawShares = Math.floor(guarded.cappedCapital / req.candidatePrice);
  const lots = Math.floor(rawShares / lotSize);
  const shares = lots * lotSize;
  const capitalUsed = shares * req.candidatePrice;
  const buyFee = Math.round(capitalUsed * FEE_RATES[req.market].buy);
  const totalCost = capitalUsed + buyFee;
  const capitalUsedPct = req.totalCapital > 0 ? capitalUsed / req.totalCapital : 0;

  const warnings = [...guarded.warnings];
  if (shares === 0) warnings.push(`資金 ${guarded.cappedCapital.toLocaleString()} 不足以買 1 lot（lot=${lotSize}, price=${req.candidatePrice}）`);

  return {
    mode: config.mode,
    rawCapital: modeResult.rawCapital,
    cappedCapital: guarded.cappedCapital,
    shares,
    lots,
    capitalUsed,
    capitalUsedPct,
    buyFee,
    totalCost,
    appliedGuards: guarded.appliedGuards,
    warnings,
    letterMultiplier: modeResult.letterMultiplier,
    resonanceMultiplier: modeResult.resonanceMultiplier,
    kellyFraction: modeResult.kellyFraction,
    stopLossDistancePct: modeResult.stopLossDistancePct,
    reasoning: modeResult.reasoning,
  };
}

/** "半導體 - DRAM" → "半導體"；無破折號則回原字串 */
function industryPrefix(industry: string): string {
  return industry.split(/[-—–]/)[0].trim();
}

interface GuardedResult {
  cappedCapital: number;
  appliedGuards: string[];
  warnings: string[];
}

/**
 * Risk guards — 對 rawCapital 套上限
 *
 * 1. perPositionMaxPct：單檔不可超過 totalCapital × max
 * 2. perIndustryMaxPct：同行業（含既有）加總不可超過
 * 3. perTrackMaxPct：同軌道（含既有）加總不可超過
 * 4. portfolioMddTriggerPct：MDD > 紅燈時 raw × 0.5
 */
export function applyRiskGuards(args: {
  rawCapital: number;
  req: SizingRequest;
  config: SizingConfig;
}): GuardedResult {
  const { rawCapital, req, config } = args;
  const appliedGuards: string[] = [];
  const warnings: string[] = [];
  let capital = rawCapital;

  // MDD 紅燈降槓桿（先於其他 guard，影響後續上限）
  if (req.currentPortfolioMddPct != null && req.currentPortfolioMddPct >= config.portfolioMddTriggerPct) {
    capital = capital * 0.5;
    appliedGuards.push('mddTrigger');
    warnings.push(
      `組合 MDD ${(req.currentPortfolioMddPct * 100).toFixed(1)}% 已過紅燈門檻 ${(config.portfolioMddTriggerPct * 100).toFixed(0)}%；` +
      `sizer 自動 ×0.5 降槓桿（規則 #5：禁止放寬選股條件）`,
    );
  }

  // perPosition cap
  const perPositionCap = req.totalCapital * config.perPositionMaxPct;
  if (capital > perPositionCap) {
    capital = perPositionCap;
    appliedGuards.push('perPositionMax');
  }

  // perIndustry cap：用 prefix match（"半導體" 配 "半導體 - DRAM" / "半導體 - 晶圓代工"）
  if (req.industry) {
    const candidatePrefix = industryPrefix(req.industry);
    const sameIndustry = req.existingHoldings
      .filter(h => h.industry && industryPrefix(h.industry) === candidatePrefix)
      .reduce((s, h) => s + h.currentValue, 0);
    const industryCap = req.totalCapital * config.perIndustryMaxPct;
    const remainingIndustry = Math.max(0, industryCap - sameIndustry);
    if (capital > remainingIndustry) {
      capital = remainingIndustry;
      appliedGuards.push('perIndustryMax');
      warnings.push(
        `同行業 prefix=${candidatePrefix} 既有 ${sameIndustry.toLocaleString()}，` +
        `上限 ${(config.perIndustryMaxPct * 100).toFixed(0)}% (${industryCap.toLocaleString()})；` +
        `剩餘額度 ${remainingIndustry.toLocaleString()}`,
      );
    }
  }

  // perTrack cap
  if (req.track) {
    const sameTrack = req.existingHoldings
      .filter(h => h.track === req.track)
      .reduce((s, h) => s + h.currentValue, 0);
    const trackCap = req.totalCapital * config.perTrackMaxPct;
    const remainingTrack = Math.max(0, trackCap - sameTrack);
    if (capital > remainingTrack) {
      capital = remainingTrack;
      appliedGuards.push('perTrackMax');
      warnings.push(
        `同軌道 ${req.track} 既有 ${sameTrack.toLocaleString()}，` +
        `上限 ${(config.perTrackMaxPct * 100).toFixed(0)}%；剩餘 ${remainingTrack.toLocaleString()}`,
      );
    }
  }

  return { cappedCapital: Math.max(0, capital), appliedGuards, warnings };
}

// ────────────────────────────────────────────────────────────────────────────
// Config load/save (data/portfolio/sizing-config.json)
// ────────────────────────────────────────────────────────────────────────────

import path from 'node:path';
import { promises as fs } from 'node:fs';
import { atomicFsPut } from '@/lib/storage/atomicFsPut';

const SIZING_DIR = path.join(process.cwd(), 'data', 'portfolio');
const SIZING_FILE = path.join(SIZING_DIR, 'sizing-config.json');

export async function loadSizingConfig(): Promise<SizingConfig> {
  try {
    const raw = await fs.readFile(SIZING_FILE, 'utf-8');
    const parsed = JSON.parse(raw) as Partial<SizingConfig>;
    // merge with defaults to ensure all fields present
    return { ...DEFAULT_SIZING_CONFIG, ...parsed };
  } catch {
    return { ...DEFAULT_SIZING_CONFIG };
  }
}

export async function saveSizingConfig(config: SizingConfig): Promise<void> {
  await fs.mkdir(SIZING_DIR, { recursive: true });
  await atomicFsPut(SIZING_FILE, JSON.stringify(config, null, 2));
}
