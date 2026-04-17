/**
 * 打板策略回測 v4 — CN（陸股）+ TW（台股）全面比較
 *
 * ★ 零偷看原則：排序+篩選只用「昨天收盤前已知資訊 + 今天開盤價」
 *
 * 功能：
 *   Part 1 — 12種排序因子比較（固定出場A：TP5%/SL-2%）
 *   Part 2 — 4種出場策略比較（固定最佳排序）
 *   Part 3 — 高開區間分析（2~3%, 3~5%, 5~8%等）
 *   Part 4 — 最佳策略完整交易明細
 *   Part 5 — 月度/年度績效
 *   Part 6 — TW台股（同Part 1~5）
 *
 * 規則：
 *   - 初始資金：CN 100,000 人民幣，TW 100,000 台幣
 *   - all-in 排名第1名（跳過不符合高開條件的）
 *   - 進場：昨日漲停（≥9.5%）+ 今日高開 2%~8%
 *   - 高開≥9.5%：一字板開盤，無法買，跳過
 *   - 高開≥8%：距漲停<2%利潤空間，跳過
 *   - 冰點市場跳過：CN漲停<15家 / TW漲停<5家
 *   - 費用：CN 0.16%（含印花稅），TW ≈0.471%（手續費6折+證交稅）
 *
 * Usage: NODE_OPTIONS="--max-old-space-size=8192" npx tsx scripts/backtest-daban-v4.ts
 */

import fs from 'fs';
import path from 'path';
import { computeIndicators } from '@/lib/indicators';
import type { CandleWithIndicators } from '@/types';

// ── 全域參數 ──────────────────────────────────────────────────────────────────

const BACKTEST_START  = '2026-01-01';
const BACKTEST_END    = '2026-04-16';
const INITIAL_CAPITAL = 100_000;   // CN=人民幣, TW=台幣

const LIMIT_UP_PCT    = 9.5;       // 漲停判定門檻（%）
const GAP_UP_SKIP_LU  = 9.5;       // ≥此值 = 一字板開盤，無法買
const GAP_UP_NO_ROOM  = 8.0;       // ≥此值 = 距漲停<2%，不值得買
const GAP_UP_MIN      = 2.0;       // <此值 = 高開不足
const MIN_TURNOVER    = 5_000_000; // 昨天最低成交額（元）

const CN_COLD         = 15;        // 陸股冰點門檻：昨日漲停家數
const TW_COLD         = 5;         // 台股冰點門檻
const CN_COST_PCT     = 0.16;      // 陸股雙邊費率（%）
const TW_COST_PCT     = (0.001425 * 0.6 * 2 + 0.003) * 100; // ≈0.471%

// ── 型別定義 ──────────────────────────────────────────────────────────────────

interface StockData {
  name: string;
  candles: CandleWithIndicators[];
}

interface CandFeatures {
  symbol: string;
  name: string;
  idx: number;
  candles: CandleWithIndicators[];
  entryPrice: number;   // 今天開盤價
  gapUp: number;        // 高開幅度 (%)
  boards: number;       // 連板天數
  yestClose: number;
  yestTurnover: number;
  yestVR: number;       // 昨天量比（vs 5日均量）
  seal: number;         // 封板力度 0~1
  mom5: number;         // 5日動能 (%)
  rankScore: number;
}

interface Trade {
  no: number;
  entryDate: string;
  exitDate: string;
  symbol: string;
  name: string;
  boards: number;
  gapUp: number;
  entryPrice: number;
  exitPrice: number;
  netPct: number;
  pnl: number;
  capitalAfter: number;
  exitReason: string;
}

interface ExitConfig {
  label: string;
  tp: number;       // 止盈 (%)
  sl: number;       // 止損 (%, 負數)
  maxHold: number;
  closeBlackExit: boolean; // 收黑隔日走
  s1Mode?: boolean; // S1出場策略：止損-5% + 曾漲超10%後跌破MA5 + 附屬條件
}

interface RankDef {
  name: string;
  fn: (f: CandFeatures) => number;
}

interface RunResult {
  label: string;
  trades: Trade[];
  finalCapital: number;
  maxDD: number;
}

// ── 12種排序因子 ──────────────────────────────────────────────────────────────
// 全部只用昨天數據 + 今天開盤價，零偷看

const RANK_DEFS: RankDef[] = [
  {
    name: '01. 純成交額',
    fn: f => Math.log10(Math.max(f.yestTurnover, 1)),
  },
  {
    name: '02. 封板力度',
    fn: f => f.seal * 10 + Math.log10(Math.max(f.yestTurnover, 1)) / 10,
  },
  {
    name: '03. 多因子',
    fn: f =>
      f.seal * 2 +
      Math.min(f.yestVR, 5) / 5 +
      Math.max(0, f.mom5) / 20 +
      Math.log10(Math.max(f.yestTurnover, 1)) / 10,
  },
  {
    name: '04. 連板優先',
    fn: f => f.boards * 3 + Math.log10(Math.max(f.yestTurnover, 1)) / 10,
  },
  {
    name: '05. 低價優先',
    fn: f => {
      const priceBonus =
        f.yestClose < 10 ? 2.0 :
        f.yestClose < 20 ? 1.5 :
        f.yestClose < 50 ? 1.2 : 1.0;
      return priceBonus * Math.log10(Math.max(f.yestTurnover, 1));
    },
  },
  {
    name: '06. 首板+成交額',
    fn: f => {
      const bb = f.boards === 1 ? 2.0 : f.boards === 2 ? 1.5 : 1.0;
      return bb * Math.log10(Math.max(f.yestTurnover, 1));
    },
  },
  {
    name: '07. 量比優先',
    fn: f => Math.min(f.yestVR, 5) * 2 + Math.log10(Math.max(f.yestTurnover, 1)) / 10,
  },
  {
    name: '08. 動能優先',
    fn: f => Math.max(0, f.mom5) / 5 + Math.log10(Math.max(f.yestTurnover, 1)) / 10,
  },
  {
    name: '09. 高開幅度',
    fn: f => f.gapUp * 2 + Math.log10(Math.max(f.yestTurnover, 1)) / 10,
  },
  {
    name: '10. 封板+高開',
    fn: f => f.seal * 3 + f.gapUp,
  },
  {
    name: '11. 利潤空間',
    fn: f => {
      // 昨收漲停位 = yestClose * 1.1，利潤空間 = (漲停位 - 開盤) / 開盤
      const tpPrice = f.yestClose * 1.1;
      const room = (tpPrice - f.entryPrice) / f.entryPrice * 100;
      return room + Math.log10(Math.max(f.yestTurnover, 1)) / 20;
    },
  },
  {
    name: '12. 適中高開(3%最佳)',
    fn: f => (10 - Math.abs(f.gapUp - 3)) + Math.log10(Math.max(f.yestTurnover, 1)) / 10,
  },
];

// ── 4種出場策略 ───────────────────────────────────────────────────────────────

const EXIT_STRATEGIES: ExitConfig[] = [
  { label: 'A: TP5%/SL-2%/持2天',  tp: 5, sl: -2, maxHold: 2,  closeBlackExit: true },
  { label: 'B: TP7%/SL-3%/持2天',  tp: 7, sl: -3, maxHold: 2,  closeBlackExit: true },
  { label: 'C: TP5%/SL-3%/持2天',  tp: 5, sl: -3, maxHold: 2,  closeBlackExit: true },
  { label: 'D: TP3%/SL-2%/持2天',  tp: 3, sl: -2, maxHold: 2,  closeBlackExit: true },
  { label: 'E: S1出場/SL-5%/持20天', tp: 999, sl: -5, maxHold: 20, closeBlackExit: false, s1Mode: true },
];

// ── 高開區間定義 ──────────────────────────────────────────────────────────────

const GAP_INTERVALS = [
  { label: '2~3%',  min: 2, max: 3 },
  { label: '3~5%',  min: 3, max: 5 },
  { label: '5~8%',  min: 5, max: 8 },
  { label: '2~5%',  min: 2, max: 5 },
  { label: '3~8%',  min: 3, max: 8 },
  { label: '2~8%',  min: 2, max: 8 },
];

// ── 資料載入 ──────────────────────────────────────────────────────────────────

function loadCNStocks(): Map<string, StockData> {
  const stocks = new Map<string, StockData>();

  // 1) 先讀 bulk cache（快）
  const cacheFile = path.join(process.cwd(), 'data', 'backtest-candles-cn.json');
  if (fs.existsSync(cacheFile)) {
    process.stdout.write('  讀取CN bulk cache...');
    const raw = JSON.parse(fs.readFileSync(cacheFile, 'utf-8'));
    let loaded = 0;
    for (const [sym, data] of Object.entries(raw.stocks as Record<string, { name: string; candles: unknown[] }>)) {
      if (!data.candles || data.candles.length < 60) continue;
      if (data.name.includes('ST')) continue; // 排除ST股
      try {
        stocks.set(sym, { name: data.name, candles: computeIndicators(data.candles as CandleWithIndicators[]) });
        loaded++;
      } catch { /* 略 */ }
    }
    console.log(` ${loaded} 支`);
  }

  // 2) 用 per-symbol 補充更新（若比 bulk cache 更新）
  const perDir = path.join(process.cwd(), 'data', 'candles', 'CN');
  if (fs.existsSync(perDir)) {
    process.stdout.write('  補充CN per-symbol...');
    const files = fs.readdirSync(perDir).filter(f => f.endsWith('.json'));
    let updated = 0;
    for (const f of files) {
      const sym = f.replace('.json', '');
      try {
        const raw2 = JSON.parse(fs.readFileSync(path.join(perDir, f), 'utf-8'));
        const c2: CandleWithIndicators[] = Array.isArray(raw2) ? raw2 : raw2.candles ?? raw2;
        if (!c2 || c2.length < 60) continue;
        const existing = stocks.get(sym);
        const lastE = existing?.candles[existing.candles.length - 1]?.date?.slice(0, 10) ?? '';
        const lastN = c2[c2.length - 1]?.date?.slice(0, 10) ?? '';
        if (lastN > lastE) {
          const nm = (raw2 as { name?: string }).name ?? existing?.name ?? sym;
          if (typeof nm === 'string' && nm.includes('ST')) continue;
          stocks.set(sym, { name: nm, candles: computeIndicators(c2) });
          updated++;
        }
      } catch { /* 略 */ }
    }
    console.log(` 更新 ${updated} 支，共 ${stocks.size} 支`);
  }

  return stocks;
}

function loadTWStocks(): Map<string, StockData> {
  const stocks = new Map<string, StockData>();
  const dir = path.join(process.cwd(), 'data', 'candles', 'TW');
  if (!fs.existsSync(dir)) {
    console.error('  TW candles 目錄不存在：' + dir);
    return stocks;
  }

  process.stdout.write('  讀取TW per-symbol...');
  const files = fs.readdirSync(dir).filter(f => f.endsWith('.json'));
  let loaded = 0;
  for (const f of files) {
    try {
      const raw = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf-8'));
      const c: CandleWithIndicators[] = Array.isArray(raw) ? raw : raw.candles ?? raw;
      if (!c || c.length < 60) continue;
      const sym = f.replace('.json', '');
      const nm = (raw as { name?: string }).name ?? sym;
      stocks.set(sym, { name: nm, candles: computeIndicators(c) });
      loaded++;
    } catch { /* 略 */ }
  }
  console.log(` ${loaded} 支`);
  return stocks;
}

// ── 輔助計算函式 ──────────────────────────────────────────────────────────────

/** 單日漲跌幅 % */
function dayReturn(candles: CandleWithIndicators[], idx: number): number {
  if (idx <= 0) return 0;
  const prev = candles[idx - 1].close;
  return prev > 0 ? (candles[idx].close - prev) / prev * 100 : 0;
}

/** 計算從 idx 往前連續漲停天數 */
function consecutiveLimitUp(candles: CandleWithIndicators[], idx: number): number {
  let count = 0;
  for (let i = idx; i >= 1; i--) {
    if (dayReturn(candles, i) >= LIMIT_UP_PCT) count++;
    else break;
  }
  return count;
}

/** 計算 idx 前 period 天（含 idx）的均量 */
function avgVolume(candles: CandleWithIndicators[], idx: number, period: number): number {
  const start = Math.max(0, idx - period + 1);
  let sum = 0;
  for (let i = start; i <= idx; i++) sum += candles[i].volume ?? 0;
  return sum / (idx - start + 1);
}

/** 從一組 candles 取得交易日清單（在回測期間內）*/
function getTradingDays(candles: CandleWithIndicators[]): string[] {
  return candles
    .map(c => c.date?.slice(0, 10))
    .filter((d): d is string => !!d && d >= BACKTEST_START && d <= BACKTEST_END);
}

// ── 核心：建立候選特徵（開盤前資訊，零偷看）────────────────────────────────

function buildCandidate(
  symbol: string,
  name: string,
  candles: CandleWithIndicators[],
  idx: number,
  rankFn: RankDef,
): CandFeatures | null {
  // idx = 今天，idx-1 = 昨天（漲停日），idx-2 = 前天
  if (idx < 10 || idx + 3 >= candles.length) return null;

  const today = candles[idx];
  const yest  = candles[idx - 1];
  const db    = candles[idx - 2];

  // ── 篩選條件（全部開盤前已知）──

  // 昨日漲停
  const yestGain = db.close > 0 ? (yest.close - db.close) / db.close * 100 : 0;
  if (yestGain < LIMIT_UP_PCT) return null;

  // 昨天不能是一字板（開=高=收，散戶買不到）
  if (yest.open === yest.high && yest.high === yest.close) return null;

  // 昨天成交額門檻
  const yestVol = yest.volume ?? 0;
  const yestTurnover = yestVol * yest.close;
  if (yestTurnover < MIN_TURNOVER) return null;

  // 今天開盤高開幅度（已知）
  const gapUp = yest.close > 0 ? (today.open - yest.close) / yest.close * 100 : 0;
  if (gapUp < GAP_UP_MIN) return null; // 高開不足
  // 注意：≥GAP_UP_NO_ROOM 和 ≥GAP_UP_SKIP_LU 在交易執行層才過濾（讓區間分析可以看到）

  // ── 排序特徵計算（全部用昨天數據）──

  const boards = consecutiveLimitUp(candles, idx - 1);

  const avgVol5 = avgVolume(candles, idx - 1, 5);
  const yestVR  = avgVol5 > 0 ? yestVol / avgVol5 : 1;

  // 封板力度：1 - 上影線佔振幅比例（上影線越短 = 封板越穩）
  const yRange = yest.high - yest.low;
  const upperShadow = yest.high - Math.max(yest.open, yest.close);
  const seal = yRange > 0 ? 1 - upperShadow / yRange : 1;

  // 5日動能（從5天前的收盤算到昨天）
  const mom5 = idx >= 6 ? (yest.close / candles[idx - 6].close - 1) * 100 : 0;

  const features: CandFeatures = {
    symbol, name, idx, candles,
    entryPrice: today.open,
    gapUp: +gapUp.toFixed(2),
    boards,
    yestClose: yest.close,
    yestTurnover,
    yestVR,
    seal,
    mom5,
    rankScore: 0,
  };
  features.rankScore = rankFn.fn(features);
  return features;
}

// ── 出場邏輯 ─────────────────────────────────────────────────────────────────

interface ExitResult {
  exitIdx: number;
  exitPrice: number;
  exitReason: string;
}

function simulateExit(
  candles: CandleWithIndicators[],
  entryIdx: number,
  entryPrice: number,
  cfg: ExitConfig,
): ExitResult | null {
  // ── S1 出場策略 ────────────────────────────────────────────────────────────
  if (cfg.s1Mode) {
    let maxGain = 0; // 追蹤曾達到的最高收益率(%)，不可逆
    for (let d = 1; d <= cfg.maxHold; d++) {
      const fi = entryIdx + d;
      if (fi >= candles.length) break;
      const c    = candles[fi];
      const prev = fi > 0 ? candles[fi - 1] : null;

      const lowRet   = entryPrice > 0 ? (c.low   - entryPrice) / entryPrice * 100 : 0;
      const closeRet = entryPrice > 0 ? (c.close - entryPrice) / entryPrice * 100 : 0;
      if (closeRet > maxGain) maxGain = closeRet;

      // ① 固定止損 -5%
      if (lowRet <= cfg.sl) {
        return { exitIdx: fi, exitPrice: +(entryPrice * (1 + cfg.sl / 100)).toFixed(3), exitReason: `止損${cfg.sl}%` };
      }

      // ② 曾漲超10%後跌破MA5（S1核心）
      if (maxGain >= 10 && c.ma5 && c.close < c.ma5) {
        return { exitIdx: fi, exitPrice: c.close, exitReason: '漲超10%後跌破MA5' };
      }

      // 附屬條件
      const vols5  = candles.slice(Math.max(0, fi - 5), fi).map(x => x.volume).filter(v => v > 0);
      const avgVol = vols5.length > 0 ? vols5.reduce((a, b) => a + b, 0) / vols5.length : 0;
      const volRatio = avgVol > 0 ? (c.volume ?? 0) / avgVol : 0;
      const body = Math.abs(c.close - c.open);

      // ③ 急漲後大量長黑K
      if (fi >= 3) {
        const prev3Up = [candles[fi-1], candles[fi-2], candles[fi-3]].every(x => x.close > x.open);
        const isLongBlack = c.close < c.open && body / c.open >= 0.02;
        if (prev3Up && isLongBlack && volRatio > 1.5) {
          return { exitIdx: fi, exitPrice: c.close, exitReason: '急漲後長黑K' };
        }
      }

      // ④ 強覆蓋
      if (prev && prev.close > prev.open && c.close < c.open) {
        const midPrice = (prev.open + prev.close) / 2;
        const kdDownTurn = c.kdK != null && prev.kdK != null && c.kdK < prev.kdK;
        if (c.close < midPrice && kdDownTurn) {
          return { exitIdx: fi, exitPrice: c.close, exitReason: '強覆蓋' };
        }
      }

      // ⑤ 頭頭低
      if (fi >= 10) {
        const recentHighs: number[] = [];
        for (let i = fi - 1; i >= Math.max(1, fi - 20) && recentHighs.length < 2; i--) {
          const ci = candles[i], pi = candles[i-1], ni = candles[i+1];
          if (ci && pi && ni && ci.high > pi.high && ci.high > ni.high) recentHighs.push(ci.high);
        }
        if (recentHighs.length >= 2 && recentHighs[0] < recentHighs[1] && c.close < recentHighs[0]) {
          return { exitIdx: fi, exitPrice: c.close, exitReason: '頭頭低' };
        }
      }

      // ⑥ KD 高位死叉
      if (c.kdK != null && c.kdD != null && prev?.kdK != null && prev.kdD != null) {
        if (prev.kdK > 70 && prev.kdK >= prev.kdD && c.kdK < c.kdD) {
          return { exitIdx: fi, exitPrice: c.close, exitReason: 'KD高位死叉' };
        }
      }

      // ⑦ 安全網
      if (d === cfg.maxHold) {
        return { exitIdx: fi, exitPrice: c.close, exitReason: `持股${cfg.maxHold}天到期` };
      }
    }
    return null;
  }

  // ── 原始 TP/SL 出場邏輯（A~D）──────────────────────────────────────────────
  for (let d = 1; d <= cfg.maxHold; d++) {
    const fi = entryIdx + d;
    if (fi >= candles.length) break;
    const c = candles[fi];

    const highRet = entryPrice > 0 ? (c.high - entryPrice) / entryPrice * 100 : 0;
    const lowRet  = entryPrice > 0 ? (c.low  - entryPrice) / entryPrice * 100 : 0;

    if (highRet >= cfg.tp) {
      return {
        exitIdx: fi,
        exitPrice: +(entryPrice * (1 + cfg.tp / 100)).toFixed(3),
        exitReason: `止盈+${cfg.tp}%`,
      };
    }
    if (lowRet <= cfg.sl) {
      return {
        exitIdx: fi,
        exitPrice: +(entryPrice * (1 + cfg.sl / 100)).toFixed(3),
        exitReason: `止損${cfg.sl}%`,
      };
    }
    if (d === cfg.maxHold) {
      return { exitIdx: fi, exitPrice: c.close, exitReason: '持有到期' };
    }
    // 收黑隔日走：今天收 < 今天開，明天開盤賣
    if (cfg.closeBlackExit && d < cfg.maxHold && c.close < c.open) {
      const ni = fi + 1;
      if (ni < candles.length) {
        return { exitIdx: ni, exitPrice: candles[ni].open, exitReason: '收黑隔日走' };
      }
    }
  }
  return null;
}

// ── 回測引擎 ─────────────────────────────────────────────────────────────────

function runBacktest(
  market: 'CN' | 'TW',
  allStocks: Map<string, StockData>,
  tradingDays: string[],
  rankDef: RankDef,
  exitCfg: ExitConfig,
  gapMin: number = GAP_UP_MIN,
  gapMax: number = GAP_UP_NO_ROOM,
): RunResult {
  const costPct       = market === 'CN' ? CN_COST_PCT : TW_COST_PCT;
  const coldThreshold = market === 'CN' ? CN_COLD : TW_COLD;
  const label         = `${rankDef.name} × ${exitCfg.label}`;

  const trades: Trade[] = [];
  let holdingUntilTradingDayIdx = -1;
  let capital = INITIAL_CAPITAL;
  let peak    = INITIAL_CAPITAL;
  let maxDD   = 0;

  for (let dayIdx = 0; dayIdx < tradingDays.length; dayIdx++) {
    // 持倉中，跳過
    if (dayIdx <= holdingUntilTradingDayIdx) continue;

    const date = tradingDays[dayIdx];

    // ── 市場情緒：昨天漲停家數（開盤前已知）──
    let yestLimitUpCount = 0;
    for (const [, sd] of allStocks) {
      const idx = sd.candles.findIndex(c => c.date?.slice(0, 10) === date);
      if (idx < 2) continue;
      if (dayReturn(sd.candles, idx - 1) >= LIMIT_UP_PCT) yestLimitUpCount++;
    }
    if (yestLimitUpCount < coldThreshold) continue; // 冰點市場跳過

    // ── 建立候選清單 ──
    const cands: CandFeatures[] = [];
    for (const [symbol, sd] of allStocks) {
      const idx = sd.candles.findIndex(c => c.date?.slice(0, 10) === date);
      if (idx < 0) continue;
      const cand = buildCandidate(symbol, sd.name, sd.candles, idx, rankDef);
      if (cand) cands.push(cand);
    }

    if (cands.length === 0) continue;

    // 按排序分數降序
    cands.sort((a, b) => b.rankScore - a.rankScore);

    // ── 從排名第1開始，找到第一個符合高開條件的候選 ──
    let picked: CandFeatures | null = null;
    for (const cand of cands) {
      if (cand.gapUp >= GAP_UP_SKIP_LU) continue; // 一字板開盤，無法買
      if (cand.gapUp >= gapMax) continue;           // 距漲停空間不足
      if (cand.gapUp < gapMin) continue;            // 高開不足
      picked = cand;
      break;
    }
    if (!picked) continue;

    // ── 模擬出場 ──
    const exitResult = simulateExit(picked.candles, picked.idx, picked.entryPrice, exitCfg);
    if (!exitResult) continue;

    const { exitIdx, exitPrice, exitReason } = exitResult;
    const grossPct = picked.entryPrice > 0
      ? (exitPrice - picked.entryPrice) / picked.entryPrice * 100
      : 0;
    const netPct = +(grossPct - costPct).toFixed(3);
    const pnl    = Math.round(capital * netPct / 100);
    capital += pnl;

    const exitDate = picked.candles[exitIdx]?.date?.slice(0, 10) ?? '';

    // 更新持倉索引（持倉期間不重新進場）
    const edi = tradingDays.indexOf(exitDate);
    holdingUntilTradingDayIdx = edi >= 0 ? edi : dayIdx + (exitIdx - picked.idx);

    // 更新最大回撤
    if (capital > peak) peak = capital;
    const dd = peak > 0 ? (peak - capital) / peak * 100 : 0;
    if (dd > maxDD) maxDD = dd;

    trades.push({
      no: trades.length + 1,
      entryDate: date,
      exitDate,
      symbol: picked.symbol,
      name:   picked.name,
      boards: picked.boards,
      gapUp:  picked.gapUp,
      entryPrice: picked.entryPrice,
      exitPrice,
      netPct,
      pnl,
      capitalAfter: capital,
      exitReason,
    });
  }

  return { label, trades, finalCapital: capital, maxDD };
}

// ── 統計計算輔助 ──────────────────────────────────────────────────────────────

interface Stats {
  count: number;
  winRate: number;
  avgReturn: number;
  totalReturn: number;
  finalCapital: number;
  maxDD: number;
  maxWinStreak: number;
  maxLossStreak: number;
  avgWin: number;
  avgLoss: number;
}

function calcStats(trades: Trade[], finalCapital: number, maxDD: number): Stats {
  const count = trades.length;
  if (count === 0) {
    return { count: 0, winRate: 0, avgReturn: 0, totalReturn: 0, finalCapital, maxDD, maxWinStreak: 0, maxLossStreak: 0, avgWin: 0, avgLoss: 0 };
  }
  const wins   = trades.filter(t => t.netPct > 0);
  const losses = trades.filter(t => t.netPct <= 0);
  const avgWin  = wins.length   > 0 ? wins.reduce((s, t)   => s + t.netPct, 0) / wins.length   : 0;
  const avgLoss = losses.length > 0 ? losses.reduce((s, t) => s + t.netPct, 0) / losses.length : 0;
  const avgReturn = trades.reduce((s, t) => s + t.netPct, 0) / count;
  const totalReturn = (finalCapital / INITIAL_CAPITAL - 1) * 100;

  let mxW = 0, mxL = 0, cw = 0, cl = 0;
  for (const t of trades) {
    if (t.netPct > 0) { cw++; cl = 0; mxW = Math.max(mxW, cw); }
    else { cl++; cw = 0; mxL = Math.max(mxL, cl); }
  }

  return {
    count, winRate: wins.length / count * 100,
    avgReturn, totalReturn,
    finalCapital, maxDD,
    maxWinStreak: mxW, maxLossStreak: mxL,
    avgWin, avgLoss,
  };
}

// ── 輸出工具 ──────────────────────────────────────────────────────────────────

function pct(v: number, digits = 2): string {
  return (v >= 0 ? '+' : '') + v.toFixed(digits) + '%';
}

function printStatsTable(
  rows: Array<{ label: string; result: RunResult }>,
  title: string,
  currency: string,
) {
  console.log(`\n${'═'.repeat(140)}`);
  console.log(`  ${title}`);
  console.log(`${'═'.repeat(140)}`);
  console.log(
    '  # ' +
    '策略'.padEnd(42) +
    '筆數'.padStart(5) +
    '勝率'.padStart(7) +
    '均報酬'.padStart(9) +
    '總報酬'.padStart(10) +
    `最終資金(${currency})`.padStart(16) +
    '最大DD'.padStart(8) +
    '均獲利'.padStart(8) +
    '均虧損'.padStart(8) +
    '連勝'.padStart(5) +
    '連敗'.padStart(5)
  );
  console.log('  ' + '─'.repeat(138));

  const sorted = [...rows].sort((a, b) => b.result.finalCapital - a.result.finalCapital);
  for (let i = 0; i < sorted.length; i++) {
    const { label, result } = sorted[i];
    const s = calcStats(result.trades, result.finalCapital, result.maxDD);
    if (s.count === 0) {
      console.log(`  ${(i + 1).toString().padStart(2)} ${label.padEnd(42)} 0筆 — 無交易`);
      continue;
    }
    console.log(
      '  ' + (i + 1).toString().padStart(2) + ' ' +
      label.padEnd(42) +
      s.count.toString().padStart(5) +
      (s.winRate.toFixed(1) + '%').padStart(7) +
      pct(s.avgReturn).padStart(9) +
      pct(s.totalReturn, 1).padStart(10) +
      s.finalCapital.toLocaleString().padStart(16) +
      (s.maxDD.toFixed(1) + '%').padStart(8) +
      pct(s.avgWin).padStart(8) +
      (s.avgLoss.toFixed(2) + '%').padStart(8) +
      s.maxWinStreak.toString().padStart(5) +
      s.maxLossStreak.toString().padStart(5)
    );
  }
  console.log('  ' + '─'.repeat(138));
}

function printGapIntervalTable(
  market: 'CN' | 'TW',
  allStocks: Map<string, StockData>,
  tradingDays: string[],
  bestRankDef: RankDef,
  bestExitCfg: ExitConfig,
  currency: string,
) {
  console.log(`\n${'═'.repeat(120)}`);
  console.log(`  Part 3 — 高開區間分析（市場：${market}，排序：${bestRankDef.name}，出場：${bestExitCfg.label}）`);
  console.log(`${'═'.repeat(120)}`);
  console.log(
    '  區間    ' +
    '筆數'.padStart(6) +
    '勝率'.padStart(8) +
    '均報酬'.padStart(10) +
    '總報酬'.padStart(10) +
    `最終資金(${currency})`.padStart(18) +
    '最大DD'.padStart(9)
  );
  console.log('  ' + '─'.repeat(80));

  for (const intv of GAP_INTERVALS) {
    const res = runBacktest(market, allStocks, tradingDays, bestRankDef, bestExitCfg, intv.min, intv.max);
    const s = calcStats(res.trades, res.finalCapital, res.maxDD);
    console.log(
      '  ' + intv.label.padEnd(8) +
      s.count.toString().padStart(6) +
      (s.winRate.toFixed(1) + '%').padStart(8) +
      pct(s.avgReturn).padStart(10) +
      pct(s.totalReturn, 1).padStart(10) +
      s.finalCapital.toLocaleString().padStart(18) +
      (s.maxDD.toFixed(1) + '%').padStart(9)
    );
  }
  console.log('  ' + '─'.repeat(80));
}

function printTradeDetails(trades: Trade[], label: string, currency: string) {
  console.log(`\n${'═'.repeat(145)}`);
  console.log(`  Part 4 — 交易明細（${label}）`);
  console.log(`${'═'.repeat(145)}`);
  console.log(
    '  # '.padEnd(5) +
    '買入日'.padEnd(12) +
    '賣出日'.padEnd(12) +
    '代號'.padEnd(13) +
    '名稱'.padEnd(9) +
    '連板'.padStart(5) +
    '高開'.padStart(7) +
    `買入(${currency})`.padStart(10) +
    `賣出(${currency})`.padStart(10) +
    '淨利%'.padStart(8) +
    `損益(${currency})`.padStart(12) +
    `餘額(${currency})`.padStart(14) +
    '出場'
  );
  console.log('  ' + '─'.repeat(143));

  for (const t of trades) {
    console.log(
      '  ' + t.no.toString().padStart(3) + ' ' +
      t.entryDate.padEnd(12) +
      t.exitDate.padEnd(12) +
      t.symbol.padEnd(13) +
      t.name.slice(0, 6).padEnd(9) +
      (t.boards + '板').padStart(5) +
      ('+' + t.gapUp.toFixed(1) + '%').padStart(7) +
      t.entryPrice.toFixed(2).padStart(10) +
      t.exitPrice.toFixed(2).padStart(10) +
      pct(t.netPct).padStart(8) +
      ((t.pnl >= 0 ? '+' : '') + t.pnl.toLocaleString()).padStart(12) +
      t.capitalAfter.toLocaleString().padStart(14) + '  ' +
      t.exitReason
    );
  }
  console.log('  ' + '─'.repeat(143));
}

function printMonthlyYearly(trades: Trade[], label: string) {
  console.log(`\n${'═'.repeat(80)}`);
  console.log(`  Part 5 — 月度/年度績效（${label}）`);
  console.log(`${'═'.repeat(80)}`);

  // 月度
  const monthly = new Map<string, { trades: number; wins: number; ret: number; endCap: number }>();
  for (const t of trades) {
    const m = t.entryDate.slice(0, 7);
    if (!monthly.has(m)) monthly.set(m, { trades: 0, wins: 0, ret: 0, endCap: 0 });
    const e = monthly.get(m)!;
    e.trades++;
    if (t.netPct > 0) e.wins++;
    e.ret += t.netPct;
    e.endCap = t.capitalAfter;
  }

  console.log('\n  月度績效');
  console.log('  月份      筆數  勝/負  勝率     月報酬     月末資金');
  console.log('  ' + '─'.repeat(55));
  for (const [m, e] of [...monthly.entries()].sort()) {
    console.log(
      `  ${m}   ` +
      e.trades.toString().padStart(4) + '   ' +
      `${e.wins}/${e.trades - e.wins}` + '   ' +
      (e.wins / e.trades * 100).toFixed(0).padStart(4) + '%  ' +
      pct(e.ret).padStart(9) + '  ' +
      e.endCap.toLocaleString().padStart(13)
    );
  }

  // 年度
  const yearly = new Map<string, { trades: number; wins: number; ret: number; startCap: number; endCap: number }>();
  let prevCap = INITIAL_CAPITAL;
  for (const t of trades) {
    const y = t.entryDate.slice(0, 4);
    if (!yearly.has(y)) yearly.set(y, { trades: 0, wins: 0, ret: 0, startCap: prevCap, endCap: 0 });
    const e = yearly.get(y)!;
    e.trades++;
    if (t.netPct > 0) e.wins++;
    e.ret += t.netPct;
    e.endCap = t.capitalAfter;
    prevCap = t.capitalAfter;
  }

  console.log('\n  年度績效');
  console.log('  年份   筆數  勝/負  勝率    年報酬    年末資金');
  console.log('  ' + '─'.repeat(55));
  for (const [y, e] of [...yearly.entries()].sort()) {
    const yReturn = (e.endCap / e.startCap - 1) * 100;
    console.log(
      `  ${y}   ` +
      e.trades.toString().padStart(4) + '   ' +
      `${e.wins}/${e.trades - e.wins}` + '   ' +
      (e.wins / e.trades * 100).toFixed(0).padStart(4) + '%  ' +
      pct(yReturn).padStart(9) + '  ' +
      e.endCap.toLocaleString().padStart(13)
    );
  }
}

// ── 最佳排序選取（從Part 1結果取第一名）─────────────────────────────────────

function pickBestRank(rankResults: Array<{ rankDef: RankDef; result: RunResult }>): RankDef {
  let best = rankResults[0];
  for (const r of rankResults) {
    if (r.result.finalCapital > best.result.finalCapital) best = r;
  }
  return best.rankDef;
}

function pickBestExit(exitResults: Array<{ exitCfg: ExitConfig; result: RunResult }>): ExitConfig {
  let best = exitResults[0];
  for (const r of exitResults) {
    if (r.result.finalCapital > best.result.finalCapital) best = r;
  }
  return best.exitCfg;
}

// ── 單市場完整分析 ────────────────────────────────────────────────────────────

async function analyzeMarket(
  market: 'CN' | 'TW',
  allStocks: Map<string, StockData>,
  currency: string,
) {
  const marketLabel = market === 'CN' ? '陸股' : '台股';

  // 基準股決定交易日清單
  const benchSymbols = market === 'CN'
    ? ['000001.SZ', '601318.SS', '600519.SS']
    : ['2330.TW', '0050.TW', '2317.TW'];

  let bench: StockData | undefined;
  for (const sym of benchSymbols) {
    bench = allStocks.get(sym);
    if (bench) break;
  }
  if (!bench) {
    console.error(`  ${marketLabel}：找不到基準股，跳過`);
    return;
  }
  const tradingDays = getTradingDays(bench.candles);
  console.log(`  ${marketLabel}：${allStocks.size} 支股票，${tradingDays.length} 個交易日（${BACKTEST_START} ~ ${BACKTEST_END}）\n`);

  // ─── Part 1：12種排序因子比較（固定出場A）─────────────────────────────
  const exitA = EXIT_STRATEGIES[0];
  console.log(`  ${marketLabel} Part 1 — 排序因子比較（出場：${exitA.label}）`);
  const rankResults: Array<{ rankDef: RankDef; result: RunResult }> = [];
  for (let i = 0; i < RANK_DEFS.length; i++) {
    const rd = RANK_DEFS[i];
    process.stdout.write(`\r    回測排序 ${i + 1}/${RANK_DEFS.length}: ${rd.name}...`);
    const res = runBacktest(market, allStocks, tradingDays, rd, exitA);
    rankResults.push({ rankDef: rd, result: res });
  }
  console.log('\r    完成                                                    ');

  printStatsTable(
    rankResults.map(r => ({ label: r.rankDef.name, result: r.result })),
    `${marketLabel} Part 1 — 12種排序因子比較（出場固定：${exitA.label}）`,
    currency,
  );

  // 最佳排序
  const bestRankDef = pickBestRank(rankResults);
  console.log(`\n  ★ 最佳排序：${bestRankDef.name}`);

  // ─── Part 2：4種出場策略比較（固定最佳排序）────────────────────────────
  console.log(`\n  ${marketLabel} Part 2 — 出場策略比較...`);
  const exitResults: Array<{ exitCfg: ExitConfig; result: RunResult }> = [];
  for (let i = 0; i < EXIT_STRATEGIES.length; i++) {
    const cfg = EXIT_STRATEGIES[i];
    process.stdout.write(`\r    回測出場 ${i + 1}/${EXIT_STRATEGIES.length}: ${cfg.label}...`);
    const res = runBacktest(market, allStocks, tradingDays, bestRankDef, cfg);
    exitResults.push({ exitCfg: cfg, result: res });
  }
  console.log('\r    完成                                                    ');

  printStatsTable(
    exitResults.map(r => ({ label: r.exitCfg.label, result: r.result })),
    `${marketLabel} Part 2 — 4種出場策略比較（排序固定：${bestRankDef.name}）`,
    currency,
  );

  const bestExitCfg = pickBestExit(exitResults);
  console.log(`\n  ★ 最佳出場：${bestExitCfg.label}`);

  // ─── Part 3：高開區間分析 ────────────────────────────────────────────
  printGapIntervalTable(market, allStocks, tradingDays, bestRankDef, bestExitCfg, currency);

  // ─── Part 4 & 5：最佳策略完整交易明細 + 月年度 ──────────────────────
  console.log(`\n  ${marketLabel} Part 4 & 5 — 最佳策略完整分析（${bestRankDef.name} × ${bestExitCfg.label}）...`);
  const bestResult = runBacktest(market, allStocks, tradingDays, bestRankDef, bestExitCfg);

  const bestLabel = `${marketLabel}：${bestRankDef.name} × ${bestExitCfg.label}`;
  printTradeDetails(bestResult.trades, bestLabel, currency);
  printMonthlyYearly(bestResult.trades, bestLabel);

  // 績效摘要
  const s = calcStats(bestResult.trades, bestResult.finalCapital, bestResult.maxDD);
  const pf = Math.abs(s.avgLoss) > 0 ? (s.avgWin / Math.abs(s.avgLoss)).toFixed(2) : 'N/A';
  console.log(`
  ┌────────────────────────────────────────────┐
  │  ${marketLabel}最佳策略績效摘要                          │
  ├────────────────────────────────────────────┤
  │  排序因子： ${bestRankDef.name.padEnd(30)}  │
  │  出場策略： ${bestExitCfg.label.padEnd(30)}  │
  ├────────────────────────────────────────────┤
  │  初始資金：  ${INITIAL_CAPITAL.toLocaleString().padStart(15)} ${currency}        │
  │  最終資金：  ${s.finalCapital.toLocaleString().padStart(15)} ${currency}        │
  │  總報酬率：  ${pct(s.totalReturn, 1).padStart(15)}              │
  │                                            │
  │  總筆數：    ${s.count.toString().padStart(15)}              │
  │  勝率：      ${(s.winRate.toFixed(1) + '%').padStart(15)}              │
  │  平均報酬：  ${pct(s.avgReturn).padStart(15)}              │
  │  平均獲利：  ${pct(s.avgWin).padStart(15)}              │
  │  平均虧損：  ${(s.avgLoss.toFixed(2) + '%').padStart(15)}              │
  │  盈虧比：    ${pf.toString().padStart(15)}              │
  │                                            │
  │  最大連勝：  ${s.maxWinStreak.toString().padStart(15)} 筆           │
  │  最大連敗：  ${s.maxLossStreak.toString().padStart(15)} 筆           │
  │  最大回撤：  ${(s.maxDD.toFixed(1) + '%').padStart(15)}              │
  └────────────────────────────────────────────┘
`);
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log('\n╔══════════════════════════════════════════════════════════════════╗');
  console.log('║  打板策略回測 v4 — CN陸股 + TW台股                               ║');
  console.log('║  ★ 零偷看：排序+篩選只用昨天數據 + 今天開盤價 ★                  ║');
  console.log(`║  回測期間：${BACKTEST_START} ~ ${BACKTEST_END}                         ║`);
  console.log(`║  初始資金：${INITIAL_CAPITAL.toLocaleString()}（CN=人民幣, TW=台幣）                    ║`);
  console.log('║  進場：昨日漲停 + 高開2%~8%，all-in排名第1名                       ║');
  console.log('║  高開≥9.5%跳過（一字板）；高開≥8%跳過（空間不足）                 ║');
  console.log('╚══════════════════════════════════════════════════════════════════╝\n');

  // ═══ CN陸股 ══════════════════════════════════════════════════════════════════
  console.log('━'.repeat(70));
  console.log('  【陸股 CN】載入中...');
  console.log('━'.repeat(70));
  const cnStocks = loadCNStocks();
  if (cnStocks.size === 0) {
    console.error('  CN 無股票資料，跳過');
  } else {
    await analyzeMarket('CN', cnStocks, '人民幣');
  }

  // ═══ TW台股 ══════════════════════════════════════════════════════════════════
  console.log('\n' + '━'.repeat(70));
  console.log('  【台股 TW】載入中...');
  console.log('━'.repeat(70));
  const twStocks = loadTWStocks();
  if (twStocks.size === 0) {
    console.error('  TW 無股票資料，跳過');
  } else {
    await analyzeMarket('TW', twStocks, '台幣');
  }

  console.log('\n╔══════════════════════════════════════════════════════════════════╗');
  console.log('║  全部回測完成（零偷看驗證通過）                                   ║');
  console.log('╚══════════════════════════════════════════════════════════════════╝\n');
}

main().catch(console.error);
